// Owns the socket connection and routes server events into the Zustand store.
// Socket.io-client handles reconnection with sensible defaults (expo backoff);
// on reconnect we re-emit `board.subscribe` and re-hydrate.
//
// Returns:
//   status  — 'connecting' | 'ready' | 'disconnected' | 'error'
//   emit    — typed wrappers for client → server actions (used by P7)

import { useEffect, useRef, useState } from 'react';
import { io as makeClient, type Socket } from 'socket.io-client';
import {
  BoardSnapshotSchema,
} from 'shared';
import type {
  Ack,
  CardCreatedPayload,
  CardMovedPayload,
  ClientToServerEvents,
  CreateCardMessage,
  MoveCardMessage,
  ServerToClientEvents,
} from 'shared';
import { useBoardStore } from '../stores/boardStore.js';

export type ConnectionStatus =
  | 'connecting'
  | 'ready'
  | 'disconnected'
  | 'error';

type SocketT = Socket<ServerToClientEvents, ClientToServerEvents>;

export function useBoardSocket(boardId: string, apiUrl: string) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const socketRef = useRef<SocketT | null>(null);

  const hydrate = useBoardStore((s) => s.hydrate);
  const applyCardCreated = useBoardStore((s) => s.applyCardCreated);
  const applyCardMoved = useBoardStore((s) => s.applyCardMoved);
  const applyCardConflict = useBoardStore((s) => s.applyCardConflict);

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
    sock.on('disconnect', () => setStatus('disconnected'));
    sock.on('connect_error', () => setStatus('error'));

    sock.on('card.created', (p) => applyCardCreated(p.card));
    sock.on('card.moved', (p) => applyCardMoved(p));
    sock.on('card.conflict', (p) => applyCardConflict(p));

    return () => {
      sock.removeAllListeners();
      sock.close();
      socketRef.current = null;
    };
  }, [boardId, apiUrl, hydrate, applyCardCreated, applyCardMoved, applyCardConflict]);

  // Promise-wrapped emits for use by components (P7 drag path)
  const emit = {
    createCard: (p: CreateCardMessage) =>
      new Promise<Ack<CardCreatedPayload>>((resolve) => {
        socketRef.current?.emit('card.create', p, resolve);
      }),
    moveCard: (p: MoveCardMessage) =>
      new Promise<Ack<CardMovedPayload>>((resolve) => {
        socketRef.current?.emit('card.move', p, resolve);
      }),
  };

  // Full snapshot refetch — used by rollback-on-conflict in the drag handler.
  // Validates the shape against BoardSnapshotSchema so a bad response can't
  // corrupt the store.
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
