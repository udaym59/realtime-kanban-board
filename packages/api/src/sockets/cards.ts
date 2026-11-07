// Card socket handlers. Validates every incoming payload with Zod at the
// boundary; translates service errors to the ack discriminated union.
//
// `card.conflict` is sent to the OFFENDING sender only (socket.emit, not the
// room) so the client can reconcile its optimistic UI. The ack also carries
// {ok: false, reason: 'conflict'} so clients can handle either signal.

import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from 'shared';
import {
  CreateCardMessage,
  DeleteCardMessage,
  MoveCardMessage,
  UpdateCardMessage,
} from 'shared';
import {
  createCard,
  deleteCard,
  moveCard,
  updateCard,
} from '../services/cards.js';
import { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { logger } from '../lib/logger.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

// Shared conflict-signalling: mirrors the move handler. The sender gets a
// `card.conflict` event with {cardId, currentVersion} AND the ack is a
// `{ok: false, reason: 'conflict'}`. Clients handle either.
function emitConflict(
  socket: Sock,
  err: ConflictError,
  fallbackCardId: string,
): { cardId: string; currentVersion: number } {
  const ctx = err.context ?? {};
  const cardId = (ctx.cardId as string | undefined) ?? fallbackCardId;
  const currentVersion = (ctx.currentVersion as number | undefined) ?? 0;
  socket.emit('card.conflict', { cardId, currentVersion });
  return { cardId, currentVersion };
}

// Build the catch-all ack. The ack.message is a short, user-safe sentinel
// — Prisma codes and stack traces go to the server log through
// `logger.error({ err, ... })` right above every call site. The web client's
// friendlyErrorOf() maps `reason: 'invalid'` to a presentable string, so
// the message here never needs to be marketable; it's just a stable sentinel.
// `err` kept as a parameter so we don't change every call site if we add
// per-code branching later.
function internalAck(_err: unknown): { ok: false; reason: 'invalid'; message: string } {
  return { ok: false, reason: 'invalid', message: 'internal' };
}

export function registerCardSockets(_io: IO, socket: Sock) {
  socket.on('card.create', async (payload, ack) => {
    const parsed = CreateCardMessage.safeParse(payload);
    if (!parsed.success) {
      return ack({
        ok: false,
        reason: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'invalid payload',
      });
    }

    try {
      const card = await createCard(parsed.data);
      ack({ ok: true, data: { card } });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return ack({ ok: false, reason: 'not-found', message: err.message });
      }
      logger.error({ err, socketId: socket.id }, 'card.create failed');
      ack(internalAck(err));
    }
  });

  socket.on('card.move', async (payload, ack) => {
    const parsed = MoveCardMessage.safeParse(payload);
    if (!parsed.success) {
      return ack({
        ok: false,
        reason: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'invalid payload',
      });
    }

    try {
      const result = await moveCard(parsed.data);
      ack({ ok: true, data: result });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return ack({ ok: false, reason: 'not-found', message: err.message });
      }
      if (err instanceof ValidationError) {
        return ack({ ok: false, reason: 'invalid', message: err.reason });
      }
      if (err instanceof ConflictError) {
        emitConflict(socket, err, parsed.data.cardId);
        return ack({ ok: false, reason: 'conflict', message: err.message });
      }
      logger.error({ err, socketId: socket.id }, 'card.move failed');
      ack(internalAck(err));
    }
  });

  // v1.1 — partial card edit (title and/or body). Same optimistic-lock +
  // conflict shape as card.move so the web client's rollback path reuses.
  socket.on('card.update', async (payload, ack) => {
    const parsed = UpdateCardMessage.safeParse(payload);
    if (!parsed.success) {
      return ack({
        ok: false,
        reason: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'invalid payload',
      });
    }

    try {
      const result = await updateCard(parsed.data);
      ack({ ok: true, data: result });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return ack({ ok: false, reason: 'not-found', message: err.message });
      }
      if (err instanceof ValidationError) {
        return ack({ ok: false, reason: 'invalid', message: err.reason });
      }
      if (err instanceof ConflictError) {
        emitConflict(socket, err, parsed.data.cardId);
        return ack({ ok: false, reason: 'conflict', message: err.message });
      }
      logger.error({ err, socketId: socket.id }, 'card.update failed');
      ack(internalAck(err));
    }
  });

  // v1.1 — delete. Also version-locked: a delete that races a concurrent
  // edit gets rejected with conflict so the editor sees their change land.
  socket.on('card.delete', async (payload, ack) => {
    const parsed = DeleteCardMessage.safeParse(payload);
    if (!parsed.success) {
      return ack({
        ok: false,
        reason: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'invalid payload',
      });
    }

    try {
      const result = await deleteCard(parsed.data);
      ack({ ok: true, data: result });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return ack({ ok: false, reason: 'not-found', message: err.message });
      }
      if (err instanceof ConflictError) {
        emitConflict(socket, err, parsed.data.cardId);
        return ack({ ok: false, reason: 'conflict', message: err.message });
      }
      logger.error({ err, socketId: socket.id }, 'card.delete failed');
      ack(internalAck(err));
    }
  });
}
