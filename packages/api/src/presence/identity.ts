// Guest identity generator. Pure functions; no I/O, no DB.
// Used once per socket on `connection` (ADR 004).
//
// Collisions: with 16 adjectives × 16 nouns = 256 name combos and 15
// colours, two guests on the same small board could draw identical
// (name, color). Accepted at demo scale (<10 concurrent). A visible
// collision would be fixed by appending a short random suffix; not
// worth the complexity today.

import { randomUUID } from 'node:crypto';
import type { GuestInfo } from 'shared';

const ADJECTIVES = [
  'Sly', 'Nimble', 'Clever', 'Brave', 'Quiet', 'Gentle', 'Wild', 'Keen',
  'Swift', 'Merry', 'Bright', 'Calm', 'Proud', 'Steady', 'Kind', 'Sharp',
] as const;

const NOUNS = [
  'Fox', 'Otter', 'Falcon', 'Deer', 'Panda', 'Lynx', 'Owl', 'Hawk',
  'Bear', 'Wolf', 'Hare', 'Badger', 'Heron', 'Stoat', 'Marten', 'Mole',
] as const;

// Picked to stay legible against the app's dark surface (bg ≈ #0f172a-ish).
// Avoid near-black, near-white, and the accent used for card hover.
const COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#0ea5e9', // sky
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#f43f5e', // rose
] as const;

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

export function makeGuest(): GuestInfo {
  return {
    guestId: randomUUID(),
    name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    color: pick(COLORS),
  };
}
