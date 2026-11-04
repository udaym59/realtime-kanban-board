// Inline add-card expander. Closed state is a button; open state is a
// textarea + Add/Cancel row. Submit on Cmd/Ctrl+Enter or Add button; Escape
// cancels. The new card arrives via the server's `card.created` broadcast —
// no local optimistic add, which keeps the store's single source of truth.

import { useRef, useState } from 'react';
import { useSocket } from '../lib/socket-context.js';

export function AddCardForm({ columnId }: { columnId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { emit } = useSocket();

  function close() {
    setOpen(false);
    setTitle('');
  }

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const r = await emit.createCard({ columnId, title: trimmed });
      if (!r.ok) {
        console.warn('card.create rejected:', r.reason, r.message);
      }
      setTitle('');
      // Keep the form open for rapid entry; blur = close
      textareaRef.current?.focus();
    } finally {
      setBusy(false);
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
    <div className="mx-3 mb-3 space-y-2">
      <textarea
        ref={textareaRef}
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={(e) => {
          // Close only if the blur target isn't our Add button
          if (!e.relatedTarget || !e.relatedTarget.closest('[data-add-card]')) {
            close();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        placeholder="New card title"
        rows={2}
        className="w-full resize-none rounded-md bg-surface px-3 py-2 text-sm text-text
                   placeholder:text-muted/60 ring-1 ring-border/30
                   focus:outline-none focus:ring-accent/60"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-add-card
          onMouseDown={(e) => e.preventDefault() /* keep focus on textarea */}
          onClick={() => void submit()}
          disabled={busy || !title.trim()}
          className="rounded-md bg-accent/90 px-3 py-1.5 text-xs font-medium text-bg
                     hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add
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
