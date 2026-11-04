// Board state (Zustand). All events are applied idempotently — same event
// twice is a no-op, out-of-order events are detected via `version`.
//
// Shape: `columns` is sorted by position; `cardsByColumn[colId]` is sorted
// by position per column. Insert-sorted on apply keeps both lists ordered
// without a re-sort pass. Fractional-indexing keys compare lexicographically.

import { create } from 'zustand';
import type {
  BoardSnapshot,
  Card,
  CardConflictPayload,
  CardMovedPayload,
  Column,
} from 'shared';

type BoardState = {
  status: 'idle' | 'ready';
  board: { id: string; name: string } | null;
  columns: Column[];
  cardsByColumn: Record<string, Card[]>;
  // Most recent conflicts (bounded); used for the status chip
  conflicts: CardConflictPayload[];

  hydrate: (snap: BoardSnapshot) => void;
  applyCardCreated: (card: Card) => void;
  applyCardMoved: (p: CardMovedPayload) => void;
  applyCardConflict: (p: CardConflictPayload) => void;
  // Local-only move: used by the drag handler to reflect the drop immediately.
  // Does NOT bump version — authoritative version arrives via `card.moved`
  // broadcast from the server, which `applyCardMoved` reconciles idempotently.
  applyOptimisticMove: (cardId: string, toColumnId: string, newPosition: string) => void;
};

function insertSorted<T extends { position: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.position > item.position);
  return idx === -1
    ? [...list, item]
    : [...list.slice(0, idx), item, ...list.slice(idx)];
}

export const useBoardStore = create<BoardState>((set) => ({
  status: 'idle',
  board: null,
  columns: [],
  cardsByColumn: {},
  conflicts: [],

  hydrate: (snap) =>
    set(() => {
      const sortedColumns: Column[] = snap.columns
        .map(({ cards: _cards, ...col }) => col)
        .sort((a, b) => (a.position < b.position ? -1 : 1));

      const cardsByColumn: Record<string, Card[]> = {};
      for (const col of snap.columns) {
        cardsByColumn[col.id] = [...col.cards].sort((a, b) =>
          a.position < b.position ? -1 : 1,
        );
      }

      return {
        status: 'ready',
        board: { id: snap.id, name: snap.name },
        columns: sortedColumns,
        cardsByColumn,
      };
    }),

  applyCardCreated: (card) =>
    set((s) => {
      const list = s.cardsByColumn[card.columnId] ?? [];
      // Idempotent: a prior ack path or re-broadcast may have added it already
      if (list.some((c) => c.id === card.id)) return s;
      return {
        cardsByColumn: {
          ...s.cardsByColumn,
          [card.columnId]: insertSorted(list, card),
        },
      };
    }),

  applyCardMoved: (p) =>
    set((s) => {
      // Locate the card's current column
      let fromColumnId: string | null = null;
      let moving: Card | null = null;
      for (const [colId, cards] of Object.entries(s.cardsByColumn)) {
        const found = cards.find((c) => c.id === p.cardId);
        if (found) {
          fromColumnId = colId;
          moving = found;
          break;
        }
      }
      if (!moving || !fromColumnId) return s;

      // Idempotent: ignore stale or duplicate events
      if (moving.version >= p.newVersion) return s;

      const updated: Card = {
        ...moving,
        columnId: p.toColumnId,
        position: p.newPosition,
        version: p.newVersion,
      };

      const next = { ...s.cardsByColumn };
      next[fromColumnId] = (s.cardsByColumn[fromColumnId] ?? []).filter(
        (c) => c.id !== p.cardId,
      );
      next[p.toColumnId] = insertSorted(
        (s.cardsByColumn[p.toColumnId] ?? []).filter((c) => c.id !== p.cardId),
        updated,
      );
      return { cardsByColumn: next };
    }),

  applyCardConflict: (p) =>
    set((s) => ({ conflicts: [...s.conflicts.slice(-9), p] })),

  applyOptimisticMove: (cardId, toColumnId, newPosition) =>
    set((s) => {
      let fromColumnId: string | null = null;
      let moving: Card | null = null;
      for (const [colId, cards] of Object.entries(s.cardsByColumn)) {
        const found = cards.find((c) => c.id === cardId);
        if (found) {
          fromColumnId = colId;
          moving = found;
          break;
        }
      }
      if (!moving || !fromColumnId) return s;

      // Position/column change only — version stays at the original value so
      // the server's authoritative `card.moved` event will pass the idempotency
      // check (`moving.version < p.newVersion`).
      const updated: Card = {
        ...moving,
        columnId: toColumnId,
        position: newPosition,
      };

      const next = { ...s.cardsByColumn };
      next[fromColumnId] = (s.cardsByColumn[fromColumnId] ?? []).filter(
        (c) => c.id !== cardId,
      );
      next[toColumnId] = insertSorted(
        (s.cardsByColumn[toColumnId] ?? []).filter((c) => c.id !== cardId),
        updated,
      );
      return { cardsByColumn: next };
    }),
}));
