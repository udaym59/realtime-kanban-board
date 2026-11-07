// PresenceLayer — overlay rendering other users' cursors over the board.
//
// Rendered as a sibling of the board content inside the scrollable area,
// so cursors scroll with content (content-space coords, see ADR 004).
// Pointer-events: none so the overlay never steals clicks or drags.
//
// Fade rule: a cursor whose last sample is older than STALE_MS is hidden
// (but the member stays in the avatar strip — see GuestAvatars). Avoids
// stale cursors frozen on screen when a user tabs away.

import { useEffect, useState } from 'react';
import { usePresenceStore } from '../stores/presenceStore.js';

const STALE_MS = 5_000;

export function PresenceLayer() {
  const others = usePresenceStore((s) => s.others);

  // Re-render periodically so STALE_MS is actually enforced without a
  // dedicated event. Cheap — once a second while anyone is connected.
  const [, forceRerender] = useState(0);
  useEffect(() => {
    if (Object.keys(others).length === 0) return;
    const t = window.setInterval(() => forceRerender((n) => n + 1), 1_000);
    return () => window.clearInterval(t);
  }, [others]);

  const now = Date.now();

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {Object.values(others).map((o) => {
        if (o.x === null || o.y === null) return null;
        if (now - o.lastSeenAt > STALE_MS) return null;
        return (
          <Cursor
            key={o.guestId}
            x={o.x}
            y={o.y}
            name={o.name}
            color={o.color}
          />
        );
      })}
    </div>
  );
}

function Cursor({
  x,
  y,
  name,
  color,
}: {
  x: number;
  y: number;
  name: string;
  color: string;
}) {
  return (
    <div
      className="absolute will-change-transform"
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
        // Small transition so 30 Hz samples don't look choppy. Keep it
        // short — anything over ~80 ms makes the cursor feel laggy.
        transition: 'transform 60ms linear',
      }}
    >
      {/* Classic "mouse arrow" shape, filled with the guest's colour.
          The white stroke keeps it legible against varying backgrounds. */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="drop-shadow-md"
      >
        <path
          d="M4 2 L4 20 L9.5 14.5 L13 22 L16 20.5 L12.5 13 L20 13 Z"
          fill={color}
          stroke="white"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="absolute left-4 top-4 whitespace-nowrap rounded-sm px-1.5 py-0.5
                   text-[11px] font-medium leading-none text-white shadow-sm"
        style={{ backgroundColor: color }}
      >
        {name}
      </span>
    </div>
  );
}
