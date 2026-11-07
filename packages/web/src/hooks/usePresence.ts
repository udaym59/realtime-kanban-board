// usePresence — mousemove capture + throttled emit (ADR 004).
//
// Owns:
//   - the pointermove listener on the board scroll container
//   - the leading+trailing throttle (~30 Hz = 33 ms interval)
//   - converting pointer events to content-space pixel coords
//
// Does NOT own:
//   - storing other users' cursors (presenceStore)
//   - routing presence events in and out (useBoardSocket wires those;
//     this hook only CALLS emit.cursor)
//
// Coordinate space: content-space pixels, meaning the top-left of the
// board's scrollable content area (not the viewport). That's why we add
// scrollLeft/scrollTop to the client-relative delta. Receivers render
// into their own content element at the same coords; two users at the
// same scroll offset see pixel-perfect alignment, differing scrolls see
// the cursor "attached to the content" (ADR 004).

import { useEffect, useRef, type RefObject } from 'react';
import { useSocket } from '../lib/socket-context.js';

const THROTTLE_MS = 33; // ~30 fps

export function usePresence(
  areaRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const { emit } = useSocket();
  const lastSentAt = useRef(0);
  const trailing = useRef<{ x: number; y: number } | null>(null);
  const trailingTimer = useRef<number | null>(null);

  useEffect(() => {
    const area = areaRef.current;
    if (!area || !enabled) return;

    function flushTrailing() {
      trailingTimer.current = null;
      const pending = trailing.current;
      if (!pending) return;
      trailing.current = null;
      lastSentAt.current = Date.now();
      emit.cursor(pending);
    }

    function onMove(e: PointerEvent) {
      if (!area) return;
      // Ignore touch/pen — v1.2 is desktop-only (CLAUDE.md non-goal).
      if (e.pointerType !== 'mouse') return;

      const rect = area.getBoundingClientRect();
      const x = e.clientX - rect.left + area.scrollLeft;
      const y = e.clientY - rect.top + area.scrollTop;

      const now = Date.now();
      const elapsed = now - lastSentAt.current;

      if (elapsed >= THROTTLE_MS) {
        // Leading edge — emit immediately
        lastSentAt.current = now;
        trailing.current = null;
        if (trailingTimer.current !== null) {
          window.clearTimeout(trailingTimer.current);
          trailingTimer.current = null;
        }
        emit.cursor({ x, y });
      } else {
        // Trailing edge — overwrite the pending sample, schedule a flush
        trailing.current = { x, y };
        if (trailingTimer.current === null) {
          trailingTimer.current = window.setTimeout(
            flushTrailing,
            THROTTLE_MS - elapsed,
          );
        }
      }
    }

    // pointermove covers mouse + pen + touch; we filter inside onMove.
    // passive: true because we never preventDefault — it keeps scroll
    // smooth on wheel-adjacent inputs.
    area.addEventListener('pointermove', onMove, { passive: true });

    return () => {
      area.removeEventListener('pointermove', onMove);
      if (trailingTimer.current !== null) {
        window.clearTimeout(trailingTimer.current);
        trailingTimer.current = null;
      }
      trailing.current = null;
    };
  }, [areaRef, enabled, emit]);
}
