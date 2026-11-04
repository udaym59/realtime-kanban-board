import { useBoardSocket } from './hooks/useBoardSocket.js';
import { Board } from './components/Board.js';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { SocketProvider } from './lib/socket-context.js';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const BOARD_ID = import.meta.env.VITE_BOARD_ID;

export function App() {
  if (!BOARD_ID) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        VITE_BOARD_ID is not set. Add it to <code className="mx-1">packages/web/.env</code>.
      </div>
    );
  }

  const { status, emit, refetch } = useBoardSocket(BOARD_ID, API_URL);

  return (
    <SocketProvider value={{ emit, refetch }}>
      <div className="flex h-full flex-col">
        <Board />
        <ConnectionStatus status={status} />
      </div>
    </SocketProvider>
  );
}
