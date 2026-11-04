import { useEffect, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Card as CardT, Column as ColumnT } from 'shared';
import { Card } from './Card.js';
import { AddCardForm } from './AddCardForm.js';

export function Column({ column, cards }: { column: ColumnT; cards: CardT[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevCount = useRef(cards.length);

  // Auto-scroll the card list to the bottom when the column grows.
  // Matches Trello/Jira — adding a card reveals it, broadcasts from other
  // users adding to this column also show the newest content.
  // Only fires on growth (ignores reorders and deletes); harmless when the
  // column isn't actually overflowing (scrollTop stays 0).
  useEffect(() => {
    if (cards.length > prevCount.current && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
    prevCount.current = cards.length;
  }, [cards.length]);

  return (
    <section
      ref={setNodeRef}
      className={`flex w-80 flex-shrink-0 flex-col rounded-lg bg-surface/50 ring-1 transition-shadow ${
        isOver ? 'ring-accent/70 shadow-lg' : 'ring-border/30'
      }`}
    >
      <header className="flex items-center justify-between px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {column.name}
        </h2>
        <span className="rounded bg-surface px-2 py-0.5 text-xs text-muted">
          {cards.length}
        </span>
      </header>
      <SortableContext
        items={cards.map((c) => c.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={scrollRef}
          className="scroll-y-thin min-h-10 flex-1 space-y-2 overflow-y-auto px-3 pb-2"
        >
          {cards.map((c) => (
            <Card key={c.id} card={c} />
          ))}
        </div>
      </SortableContext>
      <AddCardForm columnId={column.id} />
    </section>
  );
}
