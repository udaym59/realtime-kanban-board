// Card socket handlers. Validates every incoming payload with Zod at the
// boundary; translates service errors to the ack discriminated union.
//
// `card.conflict` is sent to the OFFENDING sender only (socket.emit, not the
// room) so the client can reconcile its optimistic UI. The ack also carries
// {ok: false, reason: 'conflict'} so clients can handle either signal.

import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared';
import { CreateCardMessage, MoveCardMessage } from 'shared';
import { createCard, moveCard } from '../services/cards.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { logger } from '../lib/logger.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>;

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
      ack({ ok: false, reason: 'invalid', message: 'internal' });
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
        const ctx = err.context ?? {};
        const cardId = (ctx.cardId as string | undefined) ?? parsed.data.cardId;
        const currentVersion = (ctx.currentVersion as number | undefined) ?? 0;
        // Signal to the sender only; the room doesn't need to know
        socket.emit('card.conflict', { cardId, currentVersion });
        return ack({ ok: false, reason: 'conflict', message: err.message });
      }
      logger.error({ err, socketId: socket.id }, 'card.move failed');
      ack({ ok: false, reason: 'invalid', message: 'internal' });
    }
  });
}
