// CardDetailDrawer — v1.1 card editing surface.
//
// Behaviour:
//   - Opens for a `cardId`. Pulls the live card from the store by id so the
//     drawer always reflects the latest `card.updated` broadcast.
//   - Title is inline-editable (single-line input), body is a textarea.
//   - Save triggers on blur AND on Cmd/Ctrl+Enter. No save button.
//   - Only emits if title or body actually changed vs. last-saved baseline.
//   - Delete is one-step confirm: first click arms, second click fires. No
//     nested modal. Auto-disarms on Escape, outside click, or 4s timeout.
//
// Optimistic + rollback mirrors the card.move pattern:
//   1. Apply patch to store immediately (applyOptimisticUpdate / Delete)
//   2. Emit via socket
//   3. On !ok: refetch the snapshot — authoritative state wins
//   4. On ok: the server's broadcast will arrive and reconcile via version
//
// Drawer closure cases:
//   - user hits Escape
//   - user clicks the backdrop
//   - user clicks the X
//   - the card disappears from the store (remote delete, refetch rollback)

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useBoardStore } from '../stores/boardStore.js';
import { useSocket } from '../lib/socket-context.js';
import { useToastStore } from '../stores/toastStore.js';
import { friendlyErrorOf } from '../lib/friendly-errors.js';

type Props = {
  cardId: string;
  onClose: () => void;
};

const AUTO_DISARM_MS = 4_000;

export function CardDetailDrawer({ cardId, onClose }: Props) {
  // Subscribe to the single card by id. Zustand re-renders only when this
  // selector's output changes identity.
  const card = useBoardStore((s) => {
    for (const cards of Object.values(s.cardsByColumn)) {
      const hit = cards.find((c) => c.id === cardId);
      if (hit) return hit;
    }
    return null;
  });

  const { emit, refetch } = useSocket();
  const applyOptimisticUpdate = useBoardStore((s) => s.applyOptimisticUpdate);
  const applyOptimisticDelete = useBoardStore((s) => s.applyOptimisticDelete);

  // Local editor state. Seeded from the card and re-seeded if the card
  // identity changes (open a different card) or a broadcast lands while the
  // field isn't focused — we don't clobber the user's in-progress typing.
  const [titleDraft, setTitleDraft] = useState(card?.title ?? '');
  const [bodyDraft, setBodyDraft] = useState(card?.body ?? '');
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Baseline = last-known-saved value. Save-on-blur compares against this
  // and skips emitting when nothing changed, which matters for save-on-blur
  // because a blur fires every time focus leaves — including no-ops.
  const titleBaseline = useRef(card?.title ?? '');
  const bodyBaseline = useRef(card?.body ?? '');

  // Re-seed the baselines + drafts when the card identity changes OR the
  // card's version advances (an authoritative edit landed). Don't clobber
  // the field that currently has focus.
  useLayoutEffect(() => {
    if (!card) return;
    if (document.activeElement !== titleRef.current) {
      setTitleDraft(card.title);
      titleBaseline.current = card.title;
    }
    if (document.activeElement !== bodyRef.current) {
      setBodyDraft(card.body ?? '');
      bodyBaseline.current = card.body ?? '';
    }
  }, [card?.id, card?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delete confirmation state. First click arms; second fires.
  const [deleteArmed, setDeleteArmed] = useState(false);
  useEffect(() => {
    if (!deleteArmed) return;
    const t = setTimeout(() => setDeleteArmed(false), AUTO_DISARM_MS);
    return () => clearTimeout(t);
  }, [deleteArmed]);

  // Close if the card is gone (remote delete or refetch rollback). Doing
  // this in an effect rather than at render keeps the component tree stable
  // for the frame the parent decides to unmount us.
  useEffect(() => {
    if (!card) onClose();
  }, [card, onClose]);

  // Escape to close. Also disarms delete.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (deleteArmed) setDeleteArmed(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteArmed, onClose]);

  // ----- save path -----

  const commit = useCallback(
    async (patch: { title?: string; body?: string | null }) => {
      if (!card) return;
      // Nothing to send.
      if (patch.title === undefined && patch.body === undefined) return;

      // Optimistic apply + baseline shift. Baseline shift is key: it stops
      // the blur handler re-firing the same change if focus re-enters.
      applyOptimisticUpdate(cardId, patch);
      if (patch.title !== undefined) titleBaseline.current = patch.title;
      if (patch.body !== undefined) bodyBaseline.current = patch.body ?? '';

      const ack = await emit.updateCard({
        cardId,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        expectedVersion: card.version,
      });

      if (!ack.ok) {
        console.warn('card.update rejected:', ack.reason, ack.message);
        // Toast explains the snap-back; the drawer itself may or may not
        // stay open depending on whether the refetch still contains this
        // card. Toast is the one surface that survives either outcome.
        useToastStore.getState().show(friendlyErrorOf(ack));
        try {
          await refetch();
        } catch (err) {
          console.error('update rollback refetch failed:', err);
        }
      }
    },
    [card, cardId, applyOptimisticUpdate, emit, refetch],
  );

  const saveTitle = useCallback(() => {
    const next = titleDraft.trim();
    if (!next) {
      // Reject empty title at the UI boundary (mirrors Zod .min(1)).
      // Reset the draft to the baseline rather than silently sending nothing.
      setTitleDraft(titleBaseline.current);
      return;
    }
    if (next === titleBaseline.current) return;
    void commit({ title: next });
  }, [titleDraft, commit]);

  const saveBody = useCallback(() => {
    // Textarea sends '' when empty — translate that to null to actually
    // clear the column, matching the schema's `body: string | null`.
    const next = bodyDraft;
    const normalised: string | null = next.length === 0 ? null : next;
    const baselineNormalised: string | null =
      bodyBaseline.current.length === 0 ? null : bodyBaseline.current;
    if (normalised === baselineNormalised) return;
    void commit({ body: normalised });
  }, [bodyDraft, commit]);

  const saveAll = useCallback(() => {
    // Cmd/Ctrl+Enter — flush both if either changed.
    const titleNext = titleDraft.trim();
    const bodyNext = bodyDraft;
    const bodyNormalised: string | null =
      bodyNext.length === 0 ? null : bodyNext;
    const bodyBaselineNormalised: string | null =
      bodyBaseline.current.length === 0 ? null : bodyBaseline.current;

    const patch: { title?: string; body?: string | null } = {};
    if (titleNext && titleNext !== titleBaseline.current) patch.title = titleNext;
    if (bodyNormalised !== bodyBaselineNormalised) patch.body = bodyNormalised;
    if (patch.title === undefined && patch.body === undefined) return;
    void commit(patch);
  }, [titleDraft, bodyDraft, commit]);

  // ----- delete path -----

  const doDelete = useCallback(async () => {
    if (!card) return;
    applyOptimisticDelete(cardId);
    const ack = await emit.deleteCard({
      cardId,
      expectedVersion: card.version,
    });
    if (!ack.ok) {
      console.warn('card.delete rejected:', ack.reason, ack.message);
      // The drawer is already closing (the card vanished optimistically
      // and the auto-close effect will fire). Toast is the only surface
      // the user still sees after that.
      useToastStore.getState().show(friendlyErrorOf(ack));
      try {
        await refetch();
      } catch (err) {
        console.error('delete rollback refetch failed:', err);
      }
    }
    // Drawer will auto-close via the "card gone" effect in either path.
  }, [card, cardId, applyOptimisticDelete, emit, refetch]);

  if (!card) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit card ${card.title}`}
    >
      <aside
        className="relative flex h-full w-[480px] max-w-[90vw] flex-col gap-5 bg-surface p-6 shadow-2xl ring-1 ring-border/40"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            saveAll();
          }
        }}
      >
        <header className="flex items-start justify-between gap-3">
          <input
            ref={titleRef}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            placeholder="Untitled"
            maxLength={500}
            className="w-full bg-transparent text-lg font-semibold tracking-tight text-text
                       outline-none placeholder:text-muted/60
                       focus:ring-1 focus:ring-accent/40 rounded px-1 -mx-1"
            aria-label="Card title"
          />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded px-2 py-1 text-sm text-muted hover:bg-surface-hover hover:text-text"
            aria-label="Close drawer"
          >
            ✕
          </button>
        </header>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-muted">Description</span>
          <textarea
            ref={bodyRef}
            value={bodyDraft}
            onChange={(e) => setBodyDraft(e.target.value)}
            onBlur={saveBody}
            placeholder="Add more detail…"
            maxLength={10_000}
            rows={14}
            className="resize-none rounded-md bg-surface-hover px-3 py-2 text-sm text-text
                       outline-none ring-1 ring-border/30 placeholder:text-muted/60
                       focus:ring-accent/40"
          />
        </label>

        <footer className="mt-auto flex items-center justify-between gap-3 border-t border-border/30 pt-4">
          <span className="text-xs text-muted">
            v{card.version} · Cmd/Ctrl+Enter to save · blur to save
          </span>
          {deleteArmed ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDeleteArmed(false)}
                className="rounded px-2.5 py-1.5 text-sm text-muted hover:bg-surface-hover hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doDelete}
                className="rounded bg-red-600 px-2.5 py-1.5 text-sm font-medium text-white
                           hover:bg-red-500"
                autoFocus
              >
                Confirm delete
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDeleteArmed(true)}
              className="rounded px-2.5 py-1.5 text-sm text-red-400
                         hover:bg-red-500/10 hover:text-red-300"
            >
              Delete card
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}
