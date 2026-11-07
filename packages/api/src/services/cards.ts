// Card services — the critical path lives here.
//
// moveCard: optimistic concurrency via a `version` column, with a retry loop
// that correctly handles P2002 (unique(columnId, position)) collisions. The
// retry shifts the fractional-indexing UPPER BOUND to the colliding key,
// guaranteeing progress toward a non-colliding slot each iteration. Naive
// retry with the same inputs would regenerate the same key deterministically.
//
// updateCard / deleteCard (v1.1): share the optimistic-lock + Prisma-error-
// to-ConflictError shape. They do NOT need range-tightening (no fractional
// position write) and retry only on P2034 (serialization conflict). A
// non-match on the version predicate is a real conflict; retry with the same
// expectedVersion is futile.
//
// All three emit `pg_notify('card_events', ...)` as the final statement in
// their transaction so other API nodes see the event after the row is visible
// (commit ordering).

import { Prisma } from '@prisma/client';
import { generateKeyBetween } from 'fractional-indexing';
import type {
  Card,
  CardDeletedPayload,
  CardMovedPayload,
  CardUpdatedPayload,
  CreateCardMessage,
  DeleteCardMessage,
  MoveCardMessage,
  NotifyPayload,
  UpdateCardMessage,
} from 'shared';

import { prisma } from '../db/prisma.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../errors.js';
import { logger } from '../lib/logger.js';

const MAX_MOVE_RETRIES = 3;
// Lower cap for update/delete: only P2034 is retryable here, and it doesn't
// benefit from input tightening the way P2002 does for move. Two attempts
// is enough to absorb a brief serialization blip without masking real
// contention as a transparent client success.
const MAX_WRITE_RETRIES = 2;

// ---------------------------------------------------------------------------
// createCard — append to the end of a column
// ---------------------------------------------------------------------------

export async function createCard(input: CreateCardMessage): Promise<Card> {
  // Retry on P2002 (two concurrent creates in the same column both saw
  // the same `last` row before either committed) and P2034 (serialization
  // conflict). Each attempt re-reads `last`, so the second attempt sees
  // the winner's committed row and picks a strictly-after key.
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
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
          data: {
            columnId: input.columnId,
            title: input.title,
            // Normalise '' and undefined to null so a blank body never
            // shadows the "no body" semantic the Card schema encodes.
            body: input.body != null && input.body !== '' ? input.body : null,
            position,
          },
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
    } catch (err) {
      lastErr = err;
      const isPrismaKnown = err instanceof Prisma.PrismaClientKnownRequestError;
      const prismaCode = isPrismaKnown ? err.code : undefined;
      const isRetryable = prismaCode === 'P2002' || prismaCode === 'P2034';
      if (isRetryable && attempt < MAX_WRITE_RETRIES - 1) {
        logger.warn(
          { columnId: input.columnId, attempt: attempt + 1, code: prismaCode },
          'createCard: transient DB error, retrying',
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
          // Message intentionally generic; cardId stays in the context arg
          // so the server log carries it and the socket handler can forward
          // it in the typed `card.conflict` broadcast.
          throw new ConflictError('version mismatch', {
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
        throw new ConflictError('unresolved', {
          cardId: input.cardId,
          currentVersion,
        });
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

// ---------------------------------------------------------------------------
// updateCard — title and/or body. Optimistic lock + P2034-only retry.
// ---------------------------------------------------------------------------
//
// Why no P2002 branch: this operation never writes `position` or `columnId`,
// so the only unique index on `cards` (columnId, position) cannot fire.
// Why only two attempts: P2034 is a Postgres serialization-failure translation.
// A single retry on a fresh tx is the canonical fix — a tight loop beyond
// that masks genuine contention as transparent client success.

export async function updateCard(
  input: UpdateCardMessage,
): Promise<CardUpdatedPayload> {
  // Guard parity with the Zod refine. Zod should already have blocked this
  // at the handler boundary — but services are callable from tests/scripts
  // and this is cheap defence-in-depth.
  if (input.title === undefined && input.body === undefined) {
    throw new ValidationError('at least one of title or body must be provided');
  }

  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const card = await tx.card.findUnique({
          where: { id: input.cardId },
          select: { version: true, column: { select: { boardId: true } } },
        });
        if (!card) throw new NotFoundError(`card ${input.cardId}`);

        // Build the diff; omit keys the client didn't send so we don't
        // overwrite a concurrent edit to the untouched field.
        const data: Prisma.CardUpdateManyMutationInput = {
          version: { increment: 1 },
        };
        if (input.title !== undefined) data.title = input.title;
        if (input.body !== undefined) data.body = input.body;

        const result = await tx.card.updateMany({
          where: { id: input.cardId, version: input.expectedVersion },
          data,
        });

        if (result.count === 0) {
          // Message intentionally generic; cardId stays in the context arg
          // so the server log carries it and the socket handler can forward
          // it in the typed `card.conflict` broadcast.
          throw new ConflictError('version mismatch', {
            cardId: input.cardId,
            currentVersion: card.version,
          });
        }

        const payloadData: CardUpdatedPayload = {
          cardId: input.cardId,
          newVersion: input.expectedVersion + 1,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        };
        const payload: NotifyPayload = {
          type: 'card.updated',
          boardId: card.column.boardId,
          data: payloadData,
        };
        await tx.$executeRaw`SELECT pg_notify('card_events', ${JSON.stringify(payload)})`;

        return payloadData;
      });
    } catch (err) {
      lastErr = err;
      const isPrismaKnown = err instanceof Prisma.PrismaClientKnownRequestError;
      const prismaCode = isPrismaKnown ? err.code : undefined;

      if (prismaCode === 'P2034' && attempt < MAX_WRITE_RETRIES - 1) {
        logger.warn(
          { cardId: input.cardId, attempt: attempt + 1, code: prismaCode },
          'updateCard: serialization conflict, retrying',
        );
        continue;
      }

      if (isPrismaKnown) {
        let currentVersion = 0;
        try {
          const row = await prisma.card.findUnique({
            where: { id: input.cardId },
            select: { version: true },
          });
          currentVersion = row?.version ?? 0;
        } catch {
          /* best-effort */
        }
        logger.warn(
          { cardId: input.cardId, code: prismaCode },
          'updateCard: prisma error — translating to ConflictError',
        );
        throw new ConflictError('unresolved', {
          cardId: input.cardId,
          currentVersion,
        });
      }

      logger.error(
        { err, cardId: input.cardId },
        'updateCard: unexpected non-prisma error, propagating',
      );
      throw err;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// deleteCard — optimistic lock on version. Fires card.deleted on commit.
// ---------------------------------------------------------------------------

export async function deleteCard(
  input: DeleteCardMessage,
): Promise<CardDeletedPayload> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Read-before-write: we need boardId for the NOTIFY route and the
        // current version to distinguish NotFound from Conflict when
        // deleteMany returns 0 rows.
        const card = await tx.card.findUnique({
          where: { id: input.cardId },
          select: { version: true, column: { select: { boardId: true } } },
        });
        if (!card) throw new NotFoundError(`card ${input.cardId}`);

        const result = await tx.card.deleteMany({
          where: { id: input.cardId, version: input.expectedVersion },
        });

        if (result.count === 0) {
          // Row exists (we just read it) but version moved under us.
          // Message intentionally generic; cardId stays in the context arg
          // so the server log carries it and the socket handler can forward
          // it in the typed `card.conflict` broadcast.
          throw new ConflictError('version mismatch', {
            cardId: input.cardId,
            currentVersion: card.version,
          });
        }

        const payloadData: CardDeletedPayload = { cardId: input.cardId };
        const payload: NotifyPayload = {
          type: 'card.deleted',
          boardId: card.column.boardId,
          data: payloadData,
        };
        await tx.$executeRaw`SELECT pg_notify('card_events', ${JSON.stringify(payload)})`;

        return payloadData;
      });
    } catch (err) {
      lastErr = err;
      const isPrismaKnown = err instanceof Prisma.PrismaClientKnownRequestError;
      const prismaCode = isPrismaKnown ? err.code : undefined;

      if (prismaCode === 'P2034' && attempt < MAX_WRITE_RETRIES - 1) {
        logger.warn(
          { cardId: input.cardId, attempt: attempt + 1, code: prismaCode },
          'deleteCard: serialization conflict, retrying',
        );
        continue;
      }

      if (isPrismaKnown) {
        let currentVersion = 0;
        try {
          const row = await prisma.card.findUnique({
            where: { id: input.cardId },
            select: { version: true },
          });
          // row may be undefined if a concurrent delete already won — leave
          // currentVersion at 0; the client will refetch and notice.
          currentVersion = row?.version ?? 0;
        } catch {
          /* best-effort */
        }
        logger.warn(
          { cardId: input.cardId, code: prismaCode },
          'deleteCard: prisma error — translating to ConflictError',
        );
        throw new ConflictError('unresolved', {
          cardId: input.cardId,
          currentVersion,
        });
      }

      logger.error(
        { err, cardId: input.cardId },
        'deleteCard: unexpected non-prisma error, propagating',
      );
      throw err;
    }
  }

  throw lastErr;
}
