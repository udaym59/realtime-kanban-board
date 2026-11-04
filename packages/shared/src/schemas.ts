// Zod schemas — single source of truth for shapes crossing the HTTP + socket
// boundary. Also provides the TS types both API and web consume.
//
// Version: Zod 4. Note the ISO datetime check lives under `z.iso.*` (moved
// from the `.string().datetime()` chain in Zod 3).

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives — reuse to keep intent legible
// ---------------------------------------------------------------------------

const Uuid = z.uuid();
const Timestamp = z.iso.datetime();
const Rank = z.string().min(1); // fractional-indexing key; non-empty invariant mirrored in DB CHECK

// ---------------------------------------------------------------------------
// Entities — shape matches packages/api/prisma/schema.prisma 1:1
// ---------------------------------------------------------------------------

export const CardSchema = z.object({
  id: Uuid,
  columnId: Uuid,
  title: z.string().min(1).max(500),
  body: z.string().max(10_000).nullable(),
  position: Rank,
  version: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Card = z.infer<typeof CardSchema>;

export const ColumnSchema = z.object({
  id: Uuid,
  boardId: Uuid,
  name: z.string().min(1).max(100),
  position: Rank,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Column = z.infer<typeof ColumnSchema>;

export const BoardSchema = z.object({
  id: Uuid,
  name: z.string().min(1).max(100),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Board = z.infer<typeof BoardSchema>;

// Nested snapshot — what the server emits on `board.subscribe` ack and
// `GET /api/boards/:id`. Ordering is server-side (position asc); the schema
// enforces shape, not order.
export const BoardSnapshotSchema = BoardSchema.extend({
  columns: z.array(
    ColumnSchema.extend({
      cards: z.array(CardSchema),
    }),
  ),
});
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;

// ---------------------------------------------------------------------------
// Client → server message payloads
// ---------------------------------------------------------------------------

export const SubscribeBoardMessage = z.object({
  boardId: Uuid,
});
export type SubscribeBoardMessage = z.infer<typeof SubscribeBoardMessage>;

export const CreateCardMessage = z.object({
  columnId: Uuid,
  title: z.string().min(1).max(500),
});
export type CreateCardMessage = z.infer<typeof CreateCardMessage>;

// `afterCardId` = card the dropped card lands AFTER (null = top of column).
// `beforeCardId` = card the dropped card lands BEFORE (null = bottom of column).
// The server computes the new fractional-index key between the two.
export const MoveCardMessage = z.object({
  cardId: Uuid,
  toColumnId: Uuid,
  afterCardId: Uuid.nullable(),
  beforeCardId: Uuid.nullable(),
  expectedVersion: z.number().int().nonnegative(),
});
export type MoveCardMessage = z.infer<typeof MoveCardMessage>;

export const CreateColumnMessage = z.object({
  boardId: Uuid,
  name: z.string().min(1).max(100),
});
export type CreateColumnMessage = z.infer<typeof CreateColumnMessage>;

export const RenameColumnMessage = z.object({
  columnId: Uuid,
  name: z.string().min(1).max(100),
});
export type RenameColumnMessage = z.infer<typeof RenameColumnMessage>;
