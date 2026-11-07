// Context for the socket's emit + refetch surface. Components use `useSocket`
// to send actions and trigger a snapshot refetch for rollback. Status and
// snapshot application stay in useBoardSocket + the Zustand store.

import { createContext, useContext, type ReactNode } from 'react';
import type {
  Ack,
  CardCreatedPayload,
  CardDeletedPayload,
  CardMovedPayload,
  CardUpdatedPayload,
  CreateCardMessage,
  CursorMessage,
  DeleteCardMessage,
  MoveCardMessage,
  UpdateCardMessage,
} from 'shared';

export type SocketApi = {
  emit: {
    createCard: (p: CreateCardMessage) => Promise<Ack<CardCreatedPayload>>;
    moveCard: (p: MoveCardMessage) => Promise<Ack<CardMovedPayload>>;
    updateCard: (p: UpdateCardMessage) => Promise<Ack<CardUpdatedPayload>>;
    deleteCard: (p: DeleteCardMessage) => Promise<Ack<CardDeletedPayload>>;
    // Fire-and-forget — no ack. The hook responsible for calling this is
    // expected to throttle (see usePresence).
    cursor: (p: CursorMessage) => void;
  };
  refetch: () => Promise<void>;
};

const SocketContext = createContext<SocketApi | null>(null);

export function SocketProvider({
  value,
  children,
}: {
  value: SocketApi;
  children: ReactNode;
}) {
  return <SocketContext value={value}>{children}</SocketContext>;
}

export function useSocket(): SocketApi {
  const v = useContext(SocketContext);
  if (!v) throw new Error('useSocket must be used inside <SocketProvider>');
  return v;
}
