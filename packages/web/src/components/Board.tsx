import { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { generateKeyBetween } from 'fractional-indexing';
import { useBoardStore } from '../stores/boardStore.js';
import { useSocket } from '../lib/socket-context.js';
import { Column } from './Column.js';
import { CardView } from './Card.js';

export function Board() {
  const status = useBoardStore((s) => s.status);
  const board = useBoardStore((s) => s.board);
  const columns = useBoardStore((s) => s.columns);
  const cardsByColumn = useBoardStore((s) => s.cardsByColumn);
  const applyOptimisticMove = useBoardStore((s) => s.applyOptimisticMove);
  const { emit, refetch } = useSocket();

  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  if (status !== 'ready' || !board) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Loading board…
      </div>
    );
  }

  const activeCard =
    activeId
      ? Object.values(cardsByColumn)
          .flat()
          .find((c) => c.id === activeId) ?? null
      : null;

  function findColumnOf(cardId: string): string | null {
    for (const [colId, cards] of Object.entries(cardsByColumn)) {
      if (cards.some((c) => c.id === cardId)) return colId;
    }
    return null;
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  async function onDragEnd(e: DragEndEvent) {
    const activeIdStr = String(e.active.id);
    const overId = e.over?.id != null ? String(e.over.id) : undefined;
    setActiveId(null);
    if (!overId || overId === activeIdStr) return;

    const fromCol = findColumnOf(activeIdStr);
    if (!fromCol) return;

    const overIsColumn = columns.some((c) => c.id === overId);
    const toCol = overIsColumn ? overId : findColumnOf(overId);
    if (!toCol) return;

    const activeCardRef = cardsByColumn[fromCol]?.find(
      (c) => c.id === activeIdStr,
    );
    if (!activeCardRef) return;

    // Neighbor resolution branches:
    //   a) drop on empty column body    → append to end
    //   b) within-column drop on a card → use arrayMove to compute final order
    //                                     (needed so "drag down" works)
    //   c) cross-column drop on a card  → land BEFORE that card
    let afterCardId: string | null = null;
    let beforeCardId: string | null = null;

    if (overIsColumn) {
      const toCards = (cardsByColumn[toCol] ?? []).filter(
        (c) => c.id !== activeIdStr,
      );
      afterCardId = toCards[toCards.length - 1]?.id ?? null;
    } else if (fromCol === toCol) {
      const current = cardsByColumn[toCol] ?? [];
      const activeIdx = current.findIndex((c) => c.id === activeIdStr);
      const overIdx = current.findIndex((c) => c.id === overId);
      if (activeIdx === -1 || overIdx === -1) return;
      const reordered = arrayMove(current, activeIdx, overIdx);
      const newIdx = reordered.findIndex((c) => c.id === activeIdStr);
      afterCardId = newIdx > 0 ? reordered[newIdx - 1]!.id : null;
      beforeCardId =
        newIdx < reordered.length - 1 ? reordered[newIdx + 1]!.id : null;
    } else {
      beforeCardId = overId;
      const toCards = (cardsByColumn[toCol] ?? []).filter(
        (c) => c.id !== activeIdStr,
      );
      const overIdx = toCards.findIndex((c) => c.id === overId);
      afterCardId = overIdx > 0 ? toCards[overIdx - 1]!.id : null;
    }

    const colCards = cardsByColumn[toCol] ?? [];
    const afterPos = afterCardId
      ? colCards.find((c) => c.id === afterCardId)?.position ?? null
      : null;
    const beforePos = beforeCardId
      ? colCards.find((c) => c.id === beforeCardId)?.position ?? null
      : null;

    // No-op guard — dropped back at the same spot
    if (
      fromCol === toCol &&
      (afterPos === null || activeCardRef.position > afterPos) &&
      (beforePos === null || activeCardRef.position < beforePos)
    ) {
      return;
    }

    const newPosition = generateKeyBetween(afterPos, beforePos);
    applyOptimisticMove(activeIdStr, toCol, newPosition);

    const result = await emit.moveCard({
      cardId: activeIdStr,
      toColumnId: toCol,
      afterCardId,
      beforeCardId,
      expectedVersion: activeCardRef.version,
    });

    if (!result.ok) {
      console.warn('card.move rejected:', result.reason, result.message);
      try {
        await refetch();
      } catch (err) {
        console.error('rollback refetch failed:', err);
      }
    }
  }

  return (
    <>
      <header className="border-b border-border/30 px-6 py-3">
        <h1 className="text-base font-semibold tracking-tight">{board.name}</h1>
      </header>
      <main className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <div className="flex h-full min-w-max gap-4 p-6">
            {columns.map((col) => (
              <Column
                key={col.id}
                column={col}
                cards={cardsByColumn[col.id] ?? []}
              />
            ))}
          </div>
          <DragOverlay>
            {activeCard ? <CardView card={activeCard} dragging /> : null}
          </DragOverlay>
        </DndContext>
      </main>
    </>
  );
}
