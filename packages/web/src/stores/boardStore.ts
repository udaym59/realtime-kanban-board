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
  CardDeletedPayload,
  CardMovedPayload,
  CardUpdatedPayload,
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
  applyCardUpdated: (p: CardUpdatedPayload) => void;
  applyCardDeleted: (p: CardDeletedPayload) => void;
  applyCardConflict: (p: CardConflictPayload) => void;
  // Local-only move: used by the drag handler to reflect the drop immediately.
  // Does NOT bump version — authoritative version arrives via `card.moved`
  // broadcast from the server, which `applyCardMoved` reconciles idempotently.
  applyOptimisticMove: (cardId: string, toColumnId: string, newPosition: string) => void;
  // Local-only edit — same contract as applyOptimisticMove: version stays put;
  // the authoritative `card.updated` broadcast will reconcile with newVersion.
  applyOptimisticUpdate: (
    cardId: string,
    patch: { title?: string; body?: string | null },
  ) => void;
  // Local-only removal for an optimistic delete.
  applyOptimisticDelete: (cardId: string) => void;
};

function insertSorted<T extends { position: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.position > item.position);
  return idx === -1
    ? [...list, item]
    : [...list.slice(0, idx), item, ...list.slice(idx)];
}

function findCard(
  cardsByColumn: Record<string, Card[]>,
  cardId: string,
): { columnId: string; card: Card } | null {
  for (const [colId, cards] of Object.entries(cardsByColumn)) {
    const found = cards.find((c) => c.id === cardId);
    if (found) return { columnId: colId, card: found };
  }
  return null;
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
      const hit = findCard(s.cardsByColumn, p.cardId);
      if (!hit) return s;
      const { columnId: fromColumnId, card: moving } = hit;

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

  // Idempotency rule, same as move: drop if newVersion <= current. The
  // card stays in the same column at the same position; only title/body
  // and version change, so we rewrite in place without re-sorting.
  applyCardUpdated: (p) =>
    set((s) => {
      const hit = findCard(s.cardsByColumn, p.cardId);
      if (!hit) return s;
      const { columnId, card } = hit;
      if (card.version >= p.newVersion) return s;

      const patched: Card = {
        ...card,
        version: p.newVersion,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.body !== undefined ? { body: p.body } : {}),
      };
      return {
        cardsByColumn: {
          ...s.cardsByColumn,
          [columnId]: (s.cardsByColumn[columnId] ?? []).map((c) =>
            c.id === p.cardId ? patched : c,
          ),
        },
      };
    }),

  // Idempotent by construction — filter returns the same list if the card
  // is already gone. No version check needed: deletion is terminal.
  applyCardDeleted: (p) =>
    set((s) => {
      const hit = findCard(s.cardsByColumn, p.cardId);
      if (!hit) return s;
      return {
        cardsByColumn: {
          ...s.cardsByColumn,
          [hit.columnId]: (s.cardsByColumn[hit.columnId] ?? []).filter(
            (c) => c.id !== p.cardId,
          ),
        },
        conflicts: s.conflicts.filter((c) => c.cardId !== p.cardId),
      };
    }),

  applyCardConflict: (p) =>
    set((s) => ({ conflicts: [...s.conflicts.slice(-9), p] })),

  applyOptimisticMove: (cardId, toColumnId, newPosition) =>
    set((s) => {
      const hit = findCard(s.cardsByColumn, cardId);
      if (!hit) return s;
      const { columnId: fromColumnId, card: moving } = hit;

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

  applyOptimisticUpdate: (cardId, patch) =>
    set((s) => {
      const hit = findCard(s.cardsByColumn, cardId);
      if (!hit) return s;
      const { columnId, card } = hit;
      const patched: Card = {
        ...card,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
      };
      return {
        cardsByColumn: {
          ...s.cardsByColumn,
          [columnId]: (s.cardsByColumn[columnId] ?? []).map((c) =>
            c.id === cardId ? patched : c,
          ),
        },
      };
    }),

  applyOptimisticDelete: (cardId) =>
    set((s) => {
      const hit = findCard(s.cardsByColumn, cardId);
      if (!hit) return s;
      return {
        cardsByColumn: {
          ...s.cardsByColumn,
          [hit.columnId]: (s.cardsByColumn[hit.columnId] ?? []).filter(
            (c) => c.id !== cardId,
          ),
        },
      };
    }),
}));
