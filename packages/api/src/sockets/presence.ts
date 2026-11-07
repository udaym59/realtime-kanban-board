// Presence socket handlers (ADR 004).
//
// Direct Socket.io room emits — deliberately NOT routed through pg_notify.
// See ADR 004 §"Why presence bypasses pg_notify" for the trade-off rationale.
//
// Responsibilities on the server side:
//   - On `presence.cursor` from the sender: Zod-parse, re-broadcast to the
//     sender's board room excluding themselves. No ack (fire-and-forget).
//   - On `disconnect`: if the socket was in a board, broadcast
//     `presence.leave` to that room. Mirrors ADR 004's lifecycle: identity
//     ends when the socket ends.
//
// The matching JOIN side lives in sockets/board.ts: once board.subscribe
// succeeds and the socket is in the room, that handler fires `presence.join`
// to the rest of the room and `presence.roster` back to the new joiner.

import type { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  GuestInfo,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from 'shared';
import { CursorMessage } from 'shared';
import { logger } from '../lib/logger.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

function selfOf(socket: Sock): GuestInfo {
  const { guestId, name, color } = socket.data;
  return { guestId, name, color };
}

export function registerPresenceSockets(io: IO, socket: Sock) {
  socket.on('presence.cursor', (payload) => {
    // Silent drop on invalid payload — 30 Hz path, no ack to send errors to.
    // We log once per socket at warn level if we see malformed traffic.
    const parsed = CursorMessage.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { socketId: socket.id, issues: parsed.error.issues },
        'presence.cursor: invalid payload dropped',
      );
      return;
    }
    const boardId = socket.data.boardId;
    if (!boardId) return; // haven't subscribed yet — nothing to route to

    socket.to(`board:${boardId}`).emit('presence.cursor', {
      guestId: socket.data.guestId,
      x: parsed.data.x,
      y: parsed.data.y,
    });
  });

  socket.on('disconnect', (reason) => {
    const boardId = socket.data.boardId;
    if (!boardId) return;
    // The socket is already gone from the room by the time this fires, so
    // `io.to(room)` is fine — it won't echo back to the sender.
    io.to(`board:${boardId}`).emit('presence.leave', {
      guestId: socket.data.guestId,
    });
    logger.debug(
      { socketId: socket.id, guestId: socket.data.guestId, boardId, reason },
      'presence.leave broadcast',
    );
  });
}

// Helper re-exported for the board handler — keeps the "how to shape a
// GuestInfo from socket.data" in one place.
export { selfOf };
