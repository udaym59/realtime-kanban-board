// Toast surface — bottom-centre, above the ConnectionStatus chip's z-plane.
// Clickable (the whole toast dismisses). Kept minimal visually so a flurry
// of moves in a demo doesn't become visual noise.

import { useToastStore } from '../stores/toastStore.js';

export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-14 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className="pointer-events-auto max-w-sm rounded-md bg-surface/95 px-4 py-2 text-xs text-text
                     shadow-lg ring-1 ring-border/40 backdrop-blur hover:bg-surface"
          aria-live="polite"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
