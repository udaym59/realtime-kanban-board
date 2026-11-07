// Inline add-card expander.
//
// Closed state: a "+ Add card" button.
// Open state: a single-line title input + an optional multi-line description
// textarea + Add / Cancel row.
//
// Keyboard:
//   - Enter in the title input           → submit
//   - Enter in the description textarea  → newline (textarea default)
//   - Cmd/Ctrl+Enter in either field     → submit
//   - Escape in either field             → close (discards)
//
// Submit rules:
//   - Trim the title. Empty title → form stays open, no emit (same as
//     the Add button's disabled state).
//   - Description is trimmed; if empty, we send nothing (omitted key),
//     matching the service's "null" semantic for "no body".
//   - If the ack fails, show the message inline (red strip) and keep
//     the form open with the current text, so the user doesn't lose it.
//
// Focus / close rules:
//   - The whole form is tagged data-add-card. onBlur on either field
//     only closes if focus is leaving the form entirely — tabbing between
//     the two fields or down to the Add button keeps it open.
//   - After a successful submit the form stays open for rapid entry
//     (Trello-style), focus returns to the title input, both drafts
//     clear.

import { useRef, useState } from 'react';
import { useSocket } from '../lib/socket-context.js';
import { friendlyErrorOf } from '../lib/friendly-errors.js';

export function AddCardForm({ columnId }: { columnId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const { emit } = useSocket();

  function close() {
    setOpen(false);
    setTitle('');
    setBody('');
    setError(null);
  }

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || busy) return;
    const trimmedBody = body.trim();
    setBusy(true);
    setError(null);
    try {
      const r = await emit.createCard({
        columnId,
        title: trimmedTitle,
        ...(trimmedBody ? { body: trimmedBody } : {}),
      });
      if (!r.ok) {
        console.warn('card.create rejected:', r.reason, r.message);
        // Server message goes to the dev console; the user sees a polished
        // sentence mapped from the structured `reason`/sentinel.
        setError(friendlyErrorOf(r));
        // Keep the drafts — the user can retry without re-typing
        return;
      }
      setTitle('');
      setBody('');
      titleRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  // Close only when focus leaves the ENTIRE form — tabbing between the
  // two fields, or onto Add/Cancel, must not close it.
  function onFormBlur(e: React.FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (!next || !e.currentTarget.contains(next)) {
      // Nothing dirty? close immediately. If the user has started typing,
      // keep it open — losing a half-written card to an accidental click
      // off is worse than a form that hangs around.
      if (!title && !body) close();
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-3 mb-3 rounded-md px-3 py-2 text-left text-xs text-muted
                   hover:bg-surface/60 hover:text-text transition-colors"
      >
        + Add card
      </button>
    );
  }

  return (
    <div
      data-add-card
      onBlur={onFormBlur}
      className="mx-3 mb-3 space-y-2"
    >
      <input
        ref={titleRef}
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            // Plain Enter from the title input → submit. Cmd/Ctrl+Enter
            // also works and is the canonical shortcut from the body.
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Card title"
        maxLength={500}
        className="w-full rounded-md bg-surface px-3 py-2 text-sm text-text
                   placeholder:text-muted/60 ring-1 ring-border/30
                   focus:outline-none focus:ring-accent/60"
      />
      <textarea
        ref={bodyRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Description (optional) — ⌘/Ctrl+Enter to save"
        maxLength={10_000}
        rows={3}
        className="w-full resize-none rounded-md bg-surface px-3 py-2 text-xs text-text
                   placeholder:text-muted/60 ring-1 ring-border/30
                   focus:outline-none focus:ring-accent/60"
      />
      {error ? (
        <div className="rounded-md bg-red-500/10 px-2 py-1 text-xs text-red-300 ring-1 ring-red-500/30">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault() /* keep focus on form */}
          onClick={() => void submit()}
          disabled={busy || !title.trim()}
          className="rounded-md bg-accent/90 px-3 py-1.5 text-xs font-medium text-bg
                     hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Adding…' : 'Add card'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={close}
          className="rounded-md px-3 py-1.5 text-xs text-muted hover:text-text"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
