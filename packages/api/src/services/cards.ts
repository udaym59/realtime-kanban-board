// Card services — the critical path lives here.
//
// moveCard: optimistic concurrency via a `version` column, with a retry loop
// that correctly handles P2002 (unique(columnId, position)) collisions. The
// retry shifts the fractional-indexing UPPER BOUND to the colliding key,
// guaranteeing progress toward a non-colliding slot each iteration. Naive
// retry with the same inputs would regenerate the same key deterministically.
//
// Both move and create emit `pg_notify('card_events', ...)` as the final
// statement in their transaction so other API nodes see the event after the
// row is visible (commit ordering).

import { Prisma } from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';
import type {
  Card,
  CardMovedPayload,
  CreateCardMessage,
  MoveCardMessage,
  NotifyPayload,
} from 'shared';

import { prisma } from '../db/prisma.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { logger } from '../lib/logger.js';

const MAX_MOVE_RETRIES = 3;

// ---------------------------------------------------------------------------
// createCard — append to the end of a column
// ---------------------------------------------------------------------------

export async function createCard(input: CreateCardMessage): Promise<Card> {
  return prisma.$transaction(async (tx) => {
    const column = await tx.column.findUnique({
      where: { id: input.columnId },
      select: { boardId: true },
    });
    if (!column) throw new NotFoundError(`column ${input.columnId}`);

    const last = await tx.card.findFirst({
      where: { columnId: input.columnId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = generateKeyBetween(last?.position ?? null, null);

    const row = await tx.card.create({
      data: { columnId: input.columnId, title: input.title, position },
    });

    const card: Card = {
      id: row.id,
      columnId: row.columnId,
      title: row.title,
      body: row.body,
      position: row.position,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };

    const payload: NotifyPayload = {
      type: 'card.created',
      boardId: column.boardId,
      data: card,
    };
    await tx.$executeRaw`SELECT pg_notify('card_events', ${JSON.stringify(payload)})`;

    return card;
  });
}

// ---------------------------------------------------------------------------
// moveCard — the critical path. Optimistic lock + P2002-aware retry.
// ---------------------------------------------------------------------------

export async function moveCard(input: MoveCardMessage): Promise<CardMovedPayload> {
  // Captures the key we tried in the most recent attempt; if that key just
  // got taken by a concurrent move, we shrink the upperBound to it next time.
  let adjustedUpperBound: string | null = null;
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_MOVE_RETRIES; attempt++) {
    let generatedKey = '';

    try {
      return await prisma.$transaction(async (tx) => {
        // 1. Load the card + its board context (via column)
        const card = await tx.card.findUnique({
          where: { id: input.cardId },
          select: { version: true, column: { select: { boardId: true } } },
        });
        if (!card) throw new NotFoundError(`card ${input.cardId}`);

        // 2. Load the target column + enforce same-board invariant
        const targetColumn = await tx.column.findUnique({
          where: { id: input.toColumnId },
          select: { boardId: true },
        });
        if (!targetColumn) throw new NotFoundError(`column ${input.toColumnId}`);
        if (targetColumn.boardId !== card.column.boardId) {
          throw new ValidationError('cross-board move not allowed');
        }

        // 3. Resolve neighbor positions
        const [after, before] = await Promise.all([
          input.afterCardId
            ? tx.card.findUnique({
                where: { id: input.afterCardId },
                select: { position: true },
              })
            : null,
          input.beforeCardId
            ? tx.card.findUnique({
                where: { id: input.beforeCardId },
                select: { position: true },
              })
            : null,
        ]);

        // 4. Compute the new rank — on retry, upperBound is tightened to the
        //    previously-collided key so we land in a non-colliding slot.
        const lowerBound = after?.position ?? null;
        const upperBound = adjustedUpperBound ?? before?.position ?? null;
        generatedKey = generateKeyBetween(lowerBound, upperBound);

        // 5. Optimistic update — writes only if version is still what the
        //    client saw. 0 rows = version mismatch (stale client) OR deleted.
        const result = await tx.card.updateMany({
          where: { id: input.cardId, version: input.expectedVersion },
          data: {
            columnId: input.toColumnId,
            position: generatedKey,
            version: { increment: 1 },
          },
        });

        if (result.count === 0) {
          // Real conflict — retrying with the same expectedVersion is futile.
          throw new ConflictError(`card ${input.cardId} version mismatch`, {
            cardId: input.cardId,
            currentVersion: card.version,
          });
        }

        // 6. Fan out — last statement in the tx, fires on commit
        const data: CardMovedPayload = {
          cardId: input.cardId,
          toColumnId: input.toColumnId,
          newPosition: generatedKey,
          newVersion: input.expectedVersion + 1,
        };
        const payload: NotifyPayload = {
          type: 'card.moved',
          boardId: targetColumn.boardId,
          data,
        };
        await tx.$executeRaw`SELECT pg_notify('card_events', ${JSON.stringify(payload)})`;

        return data;
      });
    } catch (err) {
      lastErr = err;
      const isPrismaKnown = err instanceof Prisma.PrismaClientKnownRequestError;
      const prismaCode = isPrismaKnown ? err.code : undefined;

      // Retry on known transient codes:
      //   P2002 — unique(columnId, position) collision (fractional-index race)
      //   P2034 — write conflict / deadlock (Postgres serialization failure)
      const isRetryable = prismaCode === 'P2002' || prismaCode === 'P2034';

      if (isRetryable && attempt < MAX_MOVE_RETRIES - 1) {
        logger.warn(
          {
            cardId: input.cardId,
            attempt: attempt + 1,
            collidedKey: generatedKey,
            code: prismaCode,
          },
          'moveCard: transient DB error, retrying',
        );
        // Only P2002 benefits from range tightening; P2034 just needs a fresh tx
        if (prismaCode === 'P2002') adjustedUpperBound = generatedKey;
        continue;
      }

      // ANY Prisma error — exhausted retries, non-retryable code (e.g. P2028
      // interactive-tx timeout, P2024 pool timeout) — translates to a clean
      // ConflictError. The client refetches the snapshot and the user retries
      // the drag. Leaking a raw Prisma error to the socket boundary would
      // show as 'internal', which is never a useful signal for the client.
      if (isPrismaKnown) {
        let currentVersion = 0;
        try {
          const row = await prisma.card.findUnique({
            where: { id: input.cardId },
            select: { version: true },
          });
          currentVersion = row?.version ?? 0;
        } catch {
          /* best-effort — fall through with 0 */
        }
        logger.warn(
          { cardId: input.cardId, code: prismaCode },
          'moveCard: prisma error — translating to ConflictError',
        );
        throw new ConflictError(
          `card ${input.cardId} unresolved: ${prismaCode}`,
          { cardId: input.cardId, currentVersion },
        );
      }

      // Non-Prisma error — a real code bug, not a transient DB issue. Log
      // full detail and propagate; the socket handler surfaces 'internal'.
      logger.error(
        { err, cardId: input.cardId },
        'moveCard: unexpected non-prisma error, propagating',
      );
      throw err;
    }
  }

  throw lastErr;
}
