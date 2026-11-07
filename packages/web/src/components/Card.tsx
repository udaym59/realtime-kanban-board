import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card as CardT } from 'shared';

// Interactive card — used inside SortableContext in each column.
//
// Click-vs-drag separation: the drag listeners are attached to the whole
// card wrapper (so the whole surface is grabbable), but the drag sensor is
// already configured with `activationConstraint: { distance: 6 }` in
// <Board>, so a plain click never starts a drag. A pointerup without a
// preceding drag fires the `onOpen` callback.

export function Card({
  card,
  onOpen,
}: {
  card: CardT;
  onOpen: (cardId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      // pointer sensor's activation distance guarantees this fires only on
      // a true click (no drag path crossed the 6px threshold)
      onClick={() => onOpen(card.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(card.id);
        }
      }}
    >
      <CardView card={card} />
    </div>
  );
}

// Pure presentation — used by DragOverlay (floats under the cursor) and by Card
export function CardView({
  card,
  dragging = false,
}: {
  card: CardT;
  dragging?: boolean;
}) {
  return (
    <div
      className={`group rounded-md bg-surface px-3 py-2.5 shadow-sm ring-1 ring-border/30
                  hover:bg-surface-hover hover:ring-border transition-colors
                  cursor-grab active:cursor-grabbing select-none ${
                    dragging ? 'rotate-2 shadow-xl ring-accent/40' : ''
                  }`}
    >
      <div className="text-sm leading-snug text-text">{card.title}</div>
      {card.body ? (
        <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted">
          {card.body}
        </div>
      ) : null}
    </div>
  );
}
