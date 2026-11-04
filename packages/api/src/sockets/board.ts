// board.subscribe handler. Validates payload with Zod at the boundary,
// loads the snapshot, joins the client to the room `board:${boardId}`,
// and acks with the snapshot. Future card/column broadcasts land in this
// room via the Postgres LISTEN/NOTIFY bridge (P3.1).

import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared';
import { SubscribeBoardMessage } from 'shared';
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { NotFoundError } from '../errors.js';
import { getSnapshot } from '../services/boards.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

export function registerBoardSocket(_io: IO, socket: Sock) {
  socket.on('board.subscribe', async (payload, ack) => {
    const parsed = SubscribeBoardMessage.safeParse(payload);
    if (!parsed.success) {
      return ack({
        ok: false,
        reason: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'invalid payload',
      });
    }

    const { boardId } = parsed.data;

    try {
      const snapshot = await getSnapshot(prisma, boardId);
      await socket.join(`board:${boardId}`);
      logger.info({ socketId: socket.id, boardId }, 'board.subscribe joined');
      ack({ ok: true, data: snapshot });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return ack({ ok: false, reason: 'not-found', message: err.message });
      }
      logger.error({ err, socketId: socket.id, boardId }, 'board.subscribe failed');
      ack({ ok: false, reason: 'invalid', message: 'internal' });
    }
  });
}
