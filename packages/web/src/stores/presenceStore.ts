// Presence state (Zustand). Separate store from boardStore because the
// lifecycle is different: board state is loaded from a snapshot and
// evolves via durable events, presence is ephemeral and refreshes 30 Hz.
// Keeping them separate also means a flurry of cursor events doesn't
// re-trigger selectors watching board columns.
//
// Shape:
//   self    — the current client's identity (set from `presence.self`)
//   others  — map keyed by guestId; each entry carries identity + the
//             most recent cursor coords + lastSeenAt (used to hide stale
//             cursors — the member still shows in the avatar strip).

import { create } from 'zustand';
import type {
  GuestInfo,
  PresenceCursorBroadcastPayload,
} from 'shared';

export type Other = GuestInfo & {
  x: number | null;
  y: number | null;
  lastSeenAt: number; // Date.now()
};

type PresenceState = {
  self: GuestInfo | null;
  others: Record<string, Other>;

  setSelf: (info: GuestInfo) => void;
  clear: () => void;

  applyRoster: (members: GuestInfo[]) => void;
  applyJoin: (info: GuestInfo) => void;
  applyLeave: (guestId: string) => void;
  applyCursor: (p: PresenceCursorBroadcastPayload) => void;
};

export const usePresenceStore = create<PresenceState>((set) => ({
  self: null,
  others: {},

  setSelf: (info) => set({ self: info }),
  clear: () => set({ self: null, others: {} }),

  // Roster arrives once per subscribe. Overwrite — never merge — so a
  // stale entry from a prior subscribe can't linger across reconnects.
  applyRoster: (members) =>
    set(() => {
      const now = Date.now();
      const others: Record<string, Other> = {};
      for (const m of members) {
        others[m.guestId] = { ...m, x: null, y: null, lastSeenAt: now };
      }
      return { others };
    }),

  applyJoin: (info) =>
    set((s) => {
      // Idempotent — re-joining with the same guestId just refreshes lastSeen
      const existing = s.others[info.guestId];
      return {
        others: {
          ...s.others,
          [info.guestId]: existing
            ? { ...existing, ...info, lastSeenAt: Date.now() }
            : { ...info, x: null, y: null, lastSeenAt: Date.now() },
        },
      };
    }),

  applyLeave: (guestId) =>
    set((s) => {
      if (!s.others[guestId]) return s;
      const next = { ...s.others };
      delete next[guestId];
      return { others: next };
    }),

  // Cursor broadcasts arrive at ~30 Hz per active user. We're inside a
  // Zustand set, which triggers a re-render in any subscriber. Keep the
  // selector tight — components reading cursor data should subscribe to
  // `others` as a map only, then iterate inside the component, not pick
  // individual cursors as separate selector hooks.
  applyCursor: (p) =>
    set((s) => {
      const existing = s.others[p.guestId];
      if (!existing) return s; // we haven't seen a join for this id yet
      return {
        others: {
          ...s.others,
          [p.guestId]: {
            ...existing,
            x: p.x,
            y: p.y,
            lastSeenAt: Date.now(),
          },
        },
      };
    }),
}));
