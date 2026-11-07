// board.subscribe handler. Validates payload with Zod at the boundary,
// loads the snapshot, joins the client to the room `board:${boardId}`,
// and acks with the snapshot. Card/column broadcasts land in this room
// via the Postgres LISTEN/NOTIFY bridge.
//
// v1.2 additions (ADR 004):
//   - stamp the boardId onto socket.data so presence handlers can route
//     cursor broadcasts without taking the id in every payload
//   - emit `presence.roster` to the new subscriber (who else is already here)
//   - broadcast `presence.join` to the rest of the room (there is someone new)
//   The two emits are sender-isolated with socket.to vs socket.emit — the
//   joiner never sees their own join broadcast.

import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  GuestInfo,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from 'shared';
import { SubscribeBoardMessage } from 'shared';
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { NotFoundError } from '../errors.js';
import { getSnapshot } from '../services/boards.js';
import { selfOf } from './presence.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export function registerBoardSocket(io: IO, socket: Sock) {
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

      // Compute the roster BEFORE joining, so it reflects "who was already
      // here when I arrived." Then join → broadcast join → ack. If we joined
      // first, we'd have to filter ourselves out of the room-members query.
      const room = `board:${boardId}`;
      const beforeJoin = await io.in(room).fetchSockets();
      const roster: GuestInfo[] = beforeJoin.map((s) => ({
        guestId: s.data.guestId,
        name: s.data.name,
        color: s.data.color,
      }));

      await socket.join(room);
      socket.data.boardId = boardId;

      const self = selfOf(socket);
      // Tell the newcomer who's already here (self excluded).
      socket.emit('presence.roster', { members: roster });
      // Tell everyone else there's a newcomer — socket.to excludes sender.
      socket.to(room).emit('presence.join', self);

      logger.info(
        { socketId: socket.id, guestId: self.guestId, boardId, rosterSize: roster.length },
        'board.subscribe joined',
      );
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
