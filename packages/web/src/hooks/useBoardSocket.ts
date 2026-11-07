// Owns the socket connection and routes server events into the Zustand
// stores (boardStore for durable state, presenceStore for presence).
// Socket.io-client handles reconnection with sensible defaults (expo
// backoff); on reconnect we re-emit `board.subscribe` and re-hydrate.
//
// Returns:
//   status  — 'connecting' | 'ready' | 'disconnected' | 'error'
//   emit    — typed wrappers for client → server actions (incl. cursor)
//   refetch — HTTP snapshot refetch, used for rollback-on-conflict

import { useEffect, useRef, useState } from 'react';
import { io as makeClient, type Socket } from 'socket.io-client';
import { BoardSnapshotSchema } from 'shared';
import type {
  Ack,
  CardCreatedPayload,
  CardDeletedPayload,
  CardMovedPayload,
  CardUpdatedPayload,
  ClientToServerEvents,
  CreateCardMessage,
  CursorMessage,
  DeleteCardMessage,
  MoveCardMessage,
  ServerToClientEvents,
  UpdateCardMessage,
} from 'shared';
import { useBoardStore } from '../stores/boardStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

export type ConnectionStatus =
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'error';

type SocketT = Socket<ServerToClientEvents, ClientToServerEvents>;

export function useBoardSocket(boardId: string, apiUrl: string) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const socketRef = useRef<SocketT | null>(null);

  // Board (card/column) store wiring
  const hydrate = useBoardStore((s) => s.hydrate);
  const applyCardCreated = useBoardStore((s) => s.applyCardCreated);
  const applyCardMoved = useBoardStore((s) => s.applyCardMoved);
  const applyCardUpdated = useBoardStore((s) => s.applyCardUpdated);
  const applyCardDeleted = useBoardStore((s) => s.applyCardDeleted);
  const applyCardConflict = useBoardStore((s) => s.applyCardConflict);

  // Presence store wiring (ADR 004)
  const setSelf = usePresenceStore((s) => s.setSelf);
  const applyRoster = usePresenceStore((s) => s.applyRoster);
  const applyJoin = usePresenceStore((s) => s.applyJoin);
  const applyLeave = usePresenceStore((s) => s.applyLeave);
  const applyCursor = usePresenceStore((s) => s.applyCursor);
  const clearPresence = usePresenceStore((s) => s.clear);

  useEffect(() => {
    const sock: SocketT = makeClient(apiUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10_000,
    });
    socketRef.current = sock;

    const subscribe = () => {
      setStatus('connecting');
      sock.emit('board.subscribe', { boardId }, (r) => {
        if (r.ok) {
          hydrate(r.data);
          setStatus('ready');
        } else {
          console.error('board.subscribe failed:', r.reason, r.message);
          setStatus('error');
        }
      });
    };

    sock.on('connect', subscribe);
    sock.on('disconnect', () => {
      // Clear presence on disconnect — the server will have told the room
      // we're gone, and keeping stale "others" entries around until
      // reconnect would re-draw dead cursors. Self will re-arrive via
      // `presence.self` on the next successful connect with a fresh
      // identity (ADR 004: socket-lifetime only).
      setStatus('disconnected');
      clearPresence();
    });
    sock.on('connect_error', () => setStatus('error'));

    // Board events (durable, via LISTEN/NOTIFY bridge)
    sock.on('card.created', (p) => applyCardCreated(p.card));
    sock.on('card.moved', (p) => applyCardMoved(p));
    sock.on('card.updated', (p) => applyCardUpdated(p));
    sock.on('card.deleted', (p) => applyCardDeleted(p));
    sock.on('card.conflict', (p) => applyCardConflict(p));

    // Presence events (ephemeral, direct socket.io — ADR 004)
    sock.on('presence.self', (p) => setSelf(p));
    sock.on('presence.roster', (p) => applyRoster(p.members));
    sock.on('presence.join', (p) => applyJoin(p));
    sock.on('presence.leave', (p) => applyLeave(p.guestId));
    sock.on('presence.cursor', (p) => applyCursor(p));

    return () => {
      sock.removeAllListeners();
      sock.close();
      socketRef.current = null;
      clearPresence();
    };
  }, [
    boardId,
    apiUrl,
    hydrate,
    applyCardCreated,
    applyCardMoved,
    applyCardUpdated,
    applyCardDeleted,
    applyCardConflict,
    setSelf,
    applyRoster,
    applyJoin,
    applyLeave,
    applyCursor,
    clearPresence,
  ]);

  // Shared helper:
  //   - If the socket is still mid-reconnect: resolve 'invalid' immediately.
  //     Without this, a form submitted during a reconnect blip would spin
  //     `busy` forever.
  //   - Always wrap the ack in a 5 s timeout. If a handler on the server
  //     forgets to ack, or the ack is lost, the promise resolves with
  //     `reason: 'invalid'`. Visible failure beats a silent hang.
  //   - console.debug around the emit so network issues are diagnosable
  //     from the browser's own devtools without touching this file.
  const ACK_TIMEOUT_MS = 5_000;
  function emitWithAck<P, R>(event: string, p: P): Promise<Ack<R>> {
    return new Promise<Ack<R>>((resolve) => {
      const s = socketRef.current;
      if (!s || !s.connected) {
        console.debug('[socket] emit', event, '→ socket not connected');
        resolve({ ok: false, reason: 'invalid', message: 'socket not connected' });
        return;
      }
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn('[socket] emit', event, 'ack timeout — no response in', ACK_TIMEOUT_MS, 'ms');
        // Short sentinel; the UI maps it via friendlyErrorOf. The full
        // detail (including the timeout value) is on the console.warn above.
        resolve({ ok: false, reason: 'invalid', message: 'ack timeout' });
      }, ACK_TIMEOUT_MS);
      console.debug('[socket] emit', event, p);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s as any).emit(event, p, (ack: Ack<R>) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        console.debug('[socket] ack', event, ack);
        resolve(ack);
      });
    });
  }

  const emit = {
    createCard: (p: CreateCardMessage) =>
      emitWithAck<CreateCardMessage, CardCreatedPayload>('card.create', p),
    moveCard: (p: MoveCardMessage) =>
      emitWithAck<MoveCardMessage, CardMovedPayload>('card.move', p),
    updateCard: (p: UpdateCardMessage) =>
      emitWithAck<UpdateCardMessage, CardUpdatedPayload>('card.update', p),
    deleteCard: (p: DeleteCardMessage) =>
      emitWithAck<DeleteCardMessage, CardDeletedPayload>('card.delete', p),
    // Fire-and-forget. If the socket isn't ready, drop — the next mousemove
    // 33 ms later tries again. Never queue cursor events locally.
    cursor: (p: CursorMessage) => {
      socketRef.current?.emit('presence.cursor', p);
    },
  };

  // Full snapshot refetch — used by rollback-on-conflict in drag + edit paths.
  const refetch = async () => {
    const res = await fetch(`${apiUrl}/api/boards/${boardId}`);
    if (!res.ok) throw new Error(`refetch failed: HTTP ${res.status}`);
    const raw = await res.json();
    const parsed = BoardSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new Error('refetch: snapshot shape invalid');
    useBoardStore.getState().hydrate(parsed.data);
  };

  return { status, emit, refetch };
}
