// Single source of truth for user-facing wording of an ack failure.
//
// Why this exists:
//   - Server acks carry a structured `reason` + a technical `message`
//     intended for logs (e.g. "version mismatch", "internal", "card not found").
//   - The UI used to render `message ?? reason` directly, which meant demo
//     visitors could read raw Prisma codes and internal jargon.
//   - All UI error surfaces (red strip in AddCardForm, failure toasts in
//     the drawer + drag rollback) go through this mapper so they stay
//     consistent and polished. The structured values are still available
//     via console.warn for devs.
//
// Mapping policy:
//   - Two message sentinels synthesised client-side by useBoardSocket get
//     priority — they describe a connection fault rather than a logical one.
//   - Otherwise map purely by `reason`. The upstream `message` is never
//     shown to the user, but is kept in console logs for triage.

import type { AckFailure } from 'shared';

// Exact-match sentinel for a submit attempted while the socket is down.
export const SENTINEL_NOT_CONNECTED = 'socket not connected';
// Prefix-match sentinel for the client-side ack timeout wrapper.
export const SENTINEL_ACK_TIMEOUT = 'ack timeout';

export function friendlyErrorOf(ack: AckFailure): string {
  const msg = ack.message ?? '';
  if (msg === SENTINEL_NOT_CONNECTED) {
    return 'Not connected right now. Trying to reconnect…';
  }
  if (msg.startsWith(SENTINEL_ACK_TIMEOUT)) {
    return "The server didn't respond. Please try again.";
  }
  switch (ack.reason) {
    case 'conflict':
      return 'Someone else just changed this — refreshing to match.';
    case 'not-found':
      return "That's no longer there. Refreshing the board.";
    case 'forbidden':
      return "You don't have permission to do that.";
    case 'invalid':
    default:
      return 'Could not save — please try again.';
  }
}
