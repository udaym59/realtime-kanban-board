// Top-right avatar strip — everyone currently connected to the board.
// Self is shown first with a subtle "you" marker; others follow in
// join-order of their guestId lex-sort (stable, cheap, no re-ordering
// on cursor moves).

import { usePresenceStore } from '../stores/presenceStore.js';

export function GuestAvatars() {
  const self = usePresenceStore((s) => s.self);
  const others = usePresenceStore((s) => s.others);

  const othersList = Object.values(others).sort((a, b) =>
    a.guestId < b.guestId ? -1 : 1,
  );

  if (!self && othersList.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      {self ? <Avatar name={self.name} color={self.color} self /> : null}
      {othersList.map((o) => (
        <Avatar key={o.guestId} name={o.name} color={o.color} />
      ))}
    </div>
  );
}

function Avatar({
  name,
  color,
  self = false,
}: {
  name: string;
  color: string;
  self?: boolean;
}) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={`relative flex h-7 w-7 items-center justify-center rounded-full
                  text-[11px] font-semibold text-white shadow-sm ring-2
                  ${self ? 'ring-text/60' : 'ring-border/40'}`}
      style={{ backgroundColor: color }}
      // title gives the full name on hover without a tooltip component
      title={self ? `${name} (you)` : name}
      aria-label={self ? `${name} (you)` : name}
    >
      {initials}
    </div>
  );
}
