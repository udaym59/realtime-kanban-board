// Postgres LISTEN/NOTIFY bridge → socket.io rooms.
//
// One dedicated pg.Client per API instance on DIRECT_URL (NOT the pooled URL —
// LISTEN is session-scoped and PgBouncer rotates sessions between pool checkouts).
//
// Payloads are parsed through NotifyPayloadSchema (shared) so a bad producer
// can't crash the bridge; mis-shaped payloads are logged and dropped.
//
// Reconnect strategy: exponential backoff capped at 30s. The dev loop (pnpm
// dev) survives Neon idle disconnects; prod survives transient network blips.

import pg from 'pg';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared';
import { NotifyPayloadSchema } from 'shared';
import { logger } from '../lib/logger.js';

const { Client } = pg;
const CHANNEL = 'card_events';
const MAX_BACKOFF_MS = 30_000;

type IO = Server<ClientToServerEvents, ServerToClientEvents>;

export function createPgListener(io: IO) {
  let backoffMs = 500;
  let stopping = false;
  let currentClient: pg.Client | null = null;

  function routePayload(payloadText: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(payloadText);
    } catch (err) {
      logger.warn({ err, payloadText }, 'listen: non-JSON payload dropped');
      return;
    }
    const parsed = NotifyPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues, raw },
        'listen: unknown payload shape dropped',
      );
      return;
    }
    const { boardId } = parsed.data;
    const room = `board:${boardId}`;

    // Discriminated-union switch — keeps full socket.io event typing
    switch (parsed.data.type) {
      case 'card.created':
        io.to(room).emit('card.created', { card: parsed.data.data });
        break;
      case 'card.moved':
        io.to(room).emit('card.moved', parsed.data.data);
        break;
      case 'column.created':
        io.to(room).emit('column.created', { column: parsed.data.data });
        break;
      case 'column.renamed':
        io.to(room).emit('column.renamed', parsed.data.data);
        break;
    }
    logger.debug({ type: parsed.data.type, boardId }, 'listen: forwarded to room');
  }

  async function connect(): Promise<void> {
    const url = process.env.DIRECT_URL;
    if (!url) throw new Error('DIRECT_URL not set — required for LISTEN');

    const client = new Client({ connectionString: url });
    currentClient = client;

    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      routePayload(msg.payload);
    });

    client.on('error', (err) => {
      logger.error({ err }, 'listen: client error — scheduling reconnect');
      void closeAndReconnect(client);
    });

    client.on('end', () => {
      if (stopping) return;
      logger.warn('listen: connection ended — scheduling reconnect');
      void closeAndReconnect(client);
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    backoffMs = 500; // reset on successful subscribe
    logger.info({ channel: CHANNEL }, 'listen: subscribed');
  }

  async function closeAndReconnect(client: pg.Client) {
    if (stopping) return;
    try {
      await client.end();
    } catch {
      /* ignore — may already be closed */
    }
    const delay = Math.min(backoffMs, MAX_BACKOFF_MS);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    logger.info({ delayMs: delay }, 'listen: reconnecting');
    setTimeout(() => {
      connect().catch((err) => {
        logger.error({ err }, 'listen: reconnect attempt failed');
        void closeAndReconnect(client);
      });
    }, delay);
  }

  return {
    start: () => connect(),
    async stop() {
      stopping = true;
      if (currentClient) {
        try {
          await currentClient.end();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
