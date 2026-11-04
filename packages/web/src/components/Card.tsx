import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card as CardT } from 'shared';

// Interactive card — used inside SortableContext in each column
export function Card({ card }: { card: CardT }) {
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
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
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
