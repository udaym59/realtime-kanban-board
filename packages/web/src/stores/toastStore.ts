// Minimal transient-message queue.
//
// Used for UI events that need to explain themselves but shouldn't block
// anything: a rejected move that just snapped back to the server state,
// a save that failed while the drawer was closing, etc. Deliberately tiny:
// one queue, per-toast TTL auto-dismiss, click-to-dismiss, no stacking
// semantics beyond "newest at the bottom."

import { create } from 'zustand';

export type Toast = {
  id: number;
  message: string;
  // Auto-dismiss after this many ms. Click to dismiss earlier.
  ttlMs: number;
};

type ToastState = {
  toasts: Toast[];
  show: (message: string, ttlMs?: number) => void;
  dismiss: (id: number) => void;
};

// Monotonic id — resetting isn't worth the ceremony and nothing depends
// on the numeric value except React's key prop.
let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show: (message, ttlMs = 4_000) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, ttlMs }] }));
    // No cleanup of this timer on unmount — the toast store is a module
    // singleton and the setter is a no-op for an id that's already gone.
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, ttlMs);
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
