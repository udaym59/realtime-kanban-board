import type { ConnectionStatus as StatusT } from '../hooks/useBoardSocket.js';
import { useBoardStore } from '../stores/boardStore.js';

const COLORS: Record<StatusT, string> = {
  connecting: 'bg-muted',
  ready: 'bg-accent',
  disconnected: 'bg-conflict',
  error: 'bg-conflict',
};

const LABELS: Record<StatusT, string> = {
  connecting: 'Connecting…',
  ready: 'Live',
  disconnected: 'Reconnecting…',
  error: 'Connection error',
};

export function ConnectionStatus({ status }: { status: StatusT }) {
  const conflicts = useBoardStore((s) => s.conflicts.length);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 flex items-center gap-2 rounded-full bg-surface/80 px-3 py-1.5 text-xs text-muted ring-1 ring-border/40 backdrop-blur">
      <span className={`inline-block h-2 w-2 rounded-full ${COLORS[status]}`} />
      <span>{LABELS[status]}</span>
      {conflicts > 0 ? (
        <span className="ml-1 text-conflict">· {conflicts} conflict{conflicts === 1 ? '' : 's'}</span>
      ) : null}
    </div>
  );
}
