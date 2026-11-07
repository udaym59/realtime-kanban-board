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
//   - SocketData: typed socket.data carrying the guest identity; see ADR 004.
//   - Presence events bypass pg_notify (see ADR 004).

import { z } from 'zod';
import {
  CardSchema,
  ColumnSchema,
  BoardSnapshotSchema,
  SubscribeBoardMessage,
  CreateCardMessage,
  MoveCardMessage,
  UpdateCardMessage,
  DeleteCardMessage,
  CreateColumnMessage,
  RenameColumnMessage,
  CursorMessage,
} from './schemas.js';
import type {
  Card,
  Column,
  BoardSnapshot,
  SubscribeBoardMessage as SubscribeBoardMessageT,
  CreateCardMessage as CreateCardMessageT,
  MoveCardMessage as MoveCardMessageT,
  UpdateCardMessage as UpdateCardMessageT,
  DeleteCardMessage as DeleteCardMessageT,
  CreateColumnMessage as CreateColumnMessageT,
  RenameColumnMessage as RenameColumnMessageT,
  CursorMessage as CursorMessageT,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Event name constants — use these at runtime instead of magic strings
// ---------------------------------------------------------------------------

export const SOCKET_EVENTS = {
  // client → server (request/response via socket.io ack)
  SUBSCRIBE_BOARD: 'board.subscribe',
  CREATE_CARD: 'card.create',
  MOVE_CARD: 'card.move',
  UPDATE_CARD: 'card.update',
  DELETE_CARD: 'card.delete',
  CREATE_COLUMN: 'column.create',
  RENAME_COLUMN: 'column.rename',

  // client → server (fire-and-forget, high-rate)
  PRESENCE_CURSOR: 'presence.cursor',

  // server → client (broadcast via Postgres LISTEN/NOTIFY bridge → room)
  BOARD_SNAPSHOT: 'board.snapshot',
  CARD_CREATED: 'card.created',
  CARD_MOVED: 'card.moved',
  CARD_UPDATED: 'card.updated',
  CARD_DELETED: 'card.deleted',
  CARD_CONFLICT: 'card.conflict',
  COLUMN_CREATED: 'column.created',
  COLUMN_RENAMED: 'column.renamed',

  // server → client (direct Socket.io room broadcast — see ADR 004)
  PRESENCE_SELF: 'presence.self',
  PRESENCE_ROSTER: 'presence.roster',
  PRESENCE_JOIN: 'presence.join',
  PRESENCE_LEAVE: 'presence.leave',
  PRESENCE_CURSOR_BROADCAST: 'presence.cursor',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

// ---------------------------------------------------------------------------
// Ack discriminated union — every client→server event that needs a reply
// uses this shape so error handling is uniform and nothing throws across
// the socket boundary. Fire-and-forget events (presence.cursor) skip the ack.
// ---------------------------------------------------------------------------

export type AckSuccess<T> = { ok: true; data: T };
export type AckFailure = {
  ok: false;
  reason: 'conflict' | 'not-found' | 'forbidden' | 'invalid';
  message?: string;
};
export type Ack<T> = AckSuccess<T> | AckFailure;

// ---------------------------------------------------------------------------
// Presence identity + payloads (v1.2, ADR 004)
// ---------------------------------------------------------------------------

// Server-assigned, ephemeral, socket-lifetime only. No DB row.
export type GuestInfo = {
  guestId: string;
  name: string;   // e.g. "Sly Fox"
  color: string;  // hex, e.g. "#0ea5e9"
};

export type PresenceSelfPayload = GuestInfo;
export type PresenceRosterPayload = { members: GuestInfo[] };
export type PresenceJoinPayload = GuestInfo;
export type PresenceLeavePayload = { guestId: string };
export type PresenceCursorBroadcastPayload = {
  guestId: string;
  x: number;
  y: number;
};

// ---------------------------------------------------------------------------
// Server → client payload types (card/column path)
// ---------------------------------------------------------------------------

export type BoardSnapshotPayload = BoardSnapshot;
export type CardCreatedPayload = { card: Card };
export type CardMovedPayload = {
  cardId: string;
  toColumnId: string;
  newPosition: string;
  newVersion: number;
};
export type CardUpdatedPayload = {
  cardId: string;
  newVersion: number;
  title?: string;
  body?: string | null;
};
export type CardDeletedPayload = { cardId: string };
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
  'card.updated': (p: CardUpdatedPayload) => void;
  'card.deleted': (p: CardDeletedPayload) => void;
  'card.conflict': (p: CardConflictPayload) => void;
  'column.created': (p: ColumnCreatedPayload) => void;
  'column.renamed': (p: ColumnRenamedPayload) => void;

  // presence (ADR 004)
  'presence.self': (p: PresenceSelfPayload) => void;
  'presence.roster': (p: PresenceRosterPayload) => void;
  'presence.join': (p: PresenceJoinPayload) => void;
  'presence.leave': (p: PresenceLeavePayload) => void;
  'presence.cursor': (p: PresenceCursorBroadcastPayload) => void;
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
  'card.update': (
    p: UpdateCardMessageT,
    ack: (r: Ack<CardUpdatedPayload>) => void,
  ) => void;
  'card.delete': (
    p: DeleteCardMessageT,
    ack: (r: Ack<CardDeletedPayload>) => void,
  ) => void;
  'column.create': (
    p: CreateColumnMessageT,
    ack: (r: Ack<ColumnCreatedPayload>) => void,
  ) => void;
  'column.rename': (
    p: RenameColumnMessageT,
    ack: (r: Ack<ColumnRenamedPayload>) => void,
  ) => void;

  // fire-and-forget — no ack to keep the 30 Hz path cheap
  'presence.cursor': (p: CursorMessageT) => void;
}

// socket.io v4 lets us attach typed data to each socket. See ADR 004 for
// why identity lives here rather than in a cookie or DB row. boardId is
// filled in after a successful board.subscribe so the presence handler
// can route cursor broadcasts without taking the id in every payload.
export interface SocketData {
  guestId: string;
  name: string;
  color: string;
  boardId?: string;
}

// Inter-server events are unused today (single-node, see ADR 004 "Trade-off")
// but typed as a concrete empty interface so the Server<...> generic slot is
// explicit and future Redis-adapter work has a named shape to extend.
export interface InterServerEvents {
  // reserved — see ADR 003 upgrade triggers
  _placeholder?: never;
}

// Re-export the input Zod schemas so the server can `.parse()` incoming
// payloads at the handler boundary without a second import.
export {
  SubscribeBoardMessage,
  CreateCardMessage,
  MoveCardMessage,
  UpdateCardMessage,
  DeleteCardMessage,
  CreateColumnMessage,
  RenameColumnMessage,
  CursorMessage,
};

// ---------------------------------------------------------------------------
// pg_notify bridge payload — what db/listen.ts parses off `board_events`
// ---------------------------------------------------------------------------
// Presence is deliberately NOT in this union — presence bypasses pg_notify
// (ADR 004). If you find yourself adding a 'presence.*' variant here, re-read
// the "Why presence bypasses pg_notify" section first.

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
    type: z.literal('card.updated'),
    boardId: z.uuid(),
    data: z.object({
      cardId: z.uuid(),
      newVersion: z.number().int().nonnegative(),
      title: z.string().min(1).max(500).optional(),
      body: z.string().max(10_000).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal('card.deleted'),
    boardId: z.uuid(),
    data: z.object({
      cardId: z.uuid(),
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
