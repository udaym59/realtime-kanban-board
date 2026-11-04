// Socket.io event contract — one source of truth for both sides.
//
// Shape:
//   - SOCKET_EVENTS: const map of event-name string literals (runtime use)
//   - Ack<T>: discriminated union for all client→server acks (never throws)
//   - ServerToClientEvents / ClientToServerEvents: generics for
//     `new Server<...>(...)` and `io(url, {...}) as Socket<...>`, giving full
//     type inference on both ends
//   - NotifyPayloadSchema: Zod schema for the pg_notify payload the listen
//     bridge parses off `board_events`. The server MUST include `boardId` so
//     the bridge can route to `io.to('board:${boardId}')` — never `io.emit`.

import { z } from 'zod';
import {
  CardSchema,
  ColumnSchema,
  BoardSnapshotSchema,
  SubscribeBoardMessage,
  CreateCardMessage,
  MoveCardMessage,
  CreateColumnMessage,
  RenameColumnMessage,
} from './schemas.js';
import type {
  Card,
  Column,
  BoardSnapshot,
  SubscribeBoardMessage as SubscribeBoardMessageT,
  CreateCardMessage as CreateCardMessageT,
  MoveCardMessage as MoveCardMessageT,
  CreateColumnMessage as CreateColumnMessageT,
  RenameColumnMessage as RenameColumnMessageT,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Event name constants — use these at runtime instead of magic strings
// ---------------------------------------------------------------------------

export const SOCKET_EVENTS = {
  // client → server (request/response via socket.io ack)
  SUBSCRIBE_BOARD: 'board.subscribe',
  CREATE_CARD: 'card.create',
  MOVE_CARD: 'card.move',
  CREATE_COLUMN: 'column.create',
  RENAME_COLUMN: 'column.rename',

  // server → client (broadcast via Postgres LISTEN/NOTIFY bridge → room)
  BOARD_SNAPSHOT: 'board.snapshot',
  CARD_CREATED: 'card.created',
  CARD_MOVED: 'card.moved',
  CARD_CONFLICT: 'card.conflict',
  COLUMN_CREATED: 'column.created',
  COLUMN_RENAMED: 'column.renamed',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

// ---------------------------------------------------------------------------
// Ack discriminated union — every client→server event uses this shape so
// error handling is uniform and nothing throws across the socket boundary
// ---------------------------------------------------------------------------

export type AckSuccess<T> = { ok: true; data: T };
export type AckFailure = {
  ok: false;
  reason: 'conflict' | 'not-found' | 'forbidden' | 'invalid';
  message?: string;
};
export type Ack<T> = AckSuccess<T> | AckFailure;

// ---------------------------------------------------------------------------
// Server → client payload types
// ---------------------------------------------------------------------------

export type BoardSnapshotPayload = BoardSnapshot;
export type CardCreatedPayload = { card: Card };
export type CardMovedPayload = {
  cardId: string;
  toColumnId: string;
  newPosition: string;
  newVersion: number;
};
// Sent back to the OFFENDING sender only (socket.emit), not the room
export type CardConflictPayload = { cardId: string; currentVersion: number };
export type ColumnCreatedPayload = { column: Column };
export type ColumnRenamedPayload = { columnId: string; name: string };

// ---------------------------------------------------------------------------
// socket.io generic interfaces
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  'board.snapshot': (p: BoardSnapshotPayload) => void;
  'card.created': (p: CardCreatedPayload) => void;
  'card.moved': (p: CardMovedPayload) => void;
  'card.conflict': (p: CardConflictPayload) => void;
  'column.created': (p: ColumnCreatedPayload) => void;
  'column.renamed': (p: ColumnRenamedPayload) => void;
}

export interface ClientToServerEvents {
  'board.subscribe': (
    p: SubscribeBoardMessageT,
    ack: (r: Ack<BoardSnapshotPayload>) => void,
  ) => void;
  'card.create': (
    p: CreateCardMessageT,
    ack: (r: Ack<CardCreatedPayload>) => void,
  ) => void;
  'card.move': (
    p: MoveCardMessageT,
    ack: (r: Ack<CardMovedPayload>) => void,
  ) => void;
  'column.create': (
    p: CreateColumnMessageT,
    ack: (r: Ack<ColumnCreatedPayload>) => void,
  ) => void;
  'column.rename': (
    p: RenameColumnMessageT,
    ack: (r: Ack<ColumnRenamedPayload>) => void,
  ) => void;
}

// Re-export the input Zod schemas so the server can `.parse()` incoming
// payloads at the handler boundary without a second import.
export {
  SubscribeBoardMessage,
  CreateCardMessage,
  MoveCardMessage,
  CreateColumnMessage,
  RenameColumnMessage,
};

// ---------------------------------------------------------------------------
// pg_notify bridge payload — what db/listen.ts parses off `board_events`
// ---------------------------------------------------------------------------

export const NotifyPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('card.created'),
    boardId: z.uuid(),
    data: CardSchema,
  }),
  z.object({
    type: z.literal('card.moved'),
    boardId: z.uuid(),
    data: z.object({
      cardId: z.uuid(),
      toColumnId: z.uuid(),
      newPosition: z.string().min(1),
      newVersion: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal('column.created'),
    boardId: z.uuid(),
    data: ColumnSchema,
  }),
  z.object({
    type: z.literal('column.renamed'),
    boardId: z.uuid(),
    data: z.object({
      columnId: z.uuid(),
      name: z.string().min(1),
    }),
  }),
]);
export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

// Needed because we also want the full snapshot schema accessible from here
// for consumers that import the socket contract (web `useBoardSocket` hook).
export { BoardSnapshotSchema };
