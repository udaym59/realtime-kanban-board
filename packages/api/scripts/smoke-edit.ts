// Two-client card-edit smoke (v1.1).
//
// Setup: A and B both subscribe to the demo board. A seeds a card.
// Each phase pre-arms B's event waiter BEFORE A fires the action, so the
// LISTEN-driven broadcast can't race the client ack. (Without that, a
// broadcast that arrives before the handler is attached is silently lost.)
//
// Timeline, driven by A:
//   1. card.update { title: "edit-1" }      → B should receive card.updated
//   2. card.update { body: "body-1" }       → B should receive card.updated
//   3. card.update { title, body cleared }  → B should receive card.updated
//   4. card.delete                          → B should receive card.deleted
//
// Pass condition:
//   - Every A action returns {ok: true}
//   - B observes each corresponding event within OBSERVE_TIMEOUT_MS
//   - Each observed newVersion is strictly greater than the previous
//   - B's event-reconstructed state matches each patch
//   - After delete: B's state no longer has the card AND HTTP snapshot doesn't
//
// Run: pnpm --filter api smoke:edit (API must already be running)

import 'dotenv/config';
import { io as makeClient, type Socket } from 'socket.io-client';
import type {
  Card,
  CardUpdatedPayload,
  ClientToServerEvents,
  Column,
  ServerToClientEvents,
} from 'shared';

const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const BOARD_ID = process.env.DEMO_BOARD_ID;
if (!BOARD_ID) throw new Error('DEMO_BOARD_ID not set');
const OBSERVE_TIMEOUT_MS = Number(process.env.SMOKE_OBSERVE_TIMEOUT ?? 2_000);

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

type ColumnWithCards = Column & { cards: Card[] };

type Snapshot = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  columns: ColumnWithCards[];
};

function connect(label: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock: Client = makeClient(API_URL, { transports: ['websocket'] });
    sock.on('connect', () => {
      console.log(`[${label}] connected`);
      resolve(sock);
    });
    sock.on('connect_error', reject);
  });
}

function subscribe(sock: Client, boardId: string): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    sock.emit('board.subscribe', { boardId }, (r) => {
      if (!r.ok) return reject(new Error(`subscribe failed: ${r.reason}`));
      resolve(r.data as Snapshot);
    });
  });
}

// Register a one-shot listener for an event matching `predicate`. Returns a
// promise that resolves with the payload or rejects on timeout. CRITICAL:
// call this BEFORE the action that triggers the event — otherwise an event
// that fires before the listener attaches is lost (socket.io has no replay).
function armWait<K extends keyof ServerToClientEvents>(
  sock: Client,
  event: K,
  predicate: (p: Parameters<ServerToClientEvents[K]>[0]) => boolean,
  timeoutMs = OBSERVE_TIMEOUT_MS,
): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const handler = (payload: Parameters<ServerToClientEvents[K]>[0]) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      sock.off(event, handler as never);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      sock.off(event, handler as never);
      reject(new Error(`timeout waiting for ${event} (${timeoutMs}ms)`));
    }, timeoutMs);
    sock.on(event, handler as never);
  });
}

async function main() {
  const a = await connect('A');
  const b = await connect('B');

  const initial = await subscribe(a, BOARD_ID!);
  await subscribe(b, BOARD_ID!);

  const col0 = initial.columns[0];
  if (!col0) throw new Error('board has no columns — seed first');

  // Baseline state B maintains purely via events, so we can verify
  // end-to-end observability independently of the pre-armed waiters.
  const bState = new Map<string, { title: string; body: string | null; version: number }>();
  b.on('card.created', (p) => {
    bState.set(p.card.id, {
      title: p.card.title,
      body: p.card.body,
      version: p.card.version,
    });
  });
  b.on('card.updated', (p) => {
    const cur = bState.get(p.cardId);
    if (!cur) return;
    bState.set(p.cardId, {
      title: p.title !== undefined ? p.title : cur.title,
      body: p.body !== undefined ? p.body : cur.body,
      version: p.newVersion,
    });
  });
  b.on('card.deleted', (p) => {
    bState.delete(p.cardId);
  });

  // ---- Seed a card A will edit ----
  // Pre-arm B's waiter for the seed broadcast BEFORE the create call.
  // We don't know the id yet, so match on title which we control.
  const seedTitle = `smoke-edit-${Date.now()}`;
  const createdOnB = armWait(b, 'card.created', (p) => p.card.title === seedTitle);
  const seeded = await new Promise<Card>((resolve, reject) => {
    a.emit('card.create', { columnId: col0.id, title: seedTitle }, (r) => {
      if (!r.ok) return reject(new Error(`seed create failed: ${r.reason}`));
      resolve(r.data.card);
    });
  });
  console.log(`[A] seeded card ${seeded.id} v${seeded.version}`);
  await createdOnB;
  console.log('[B] saw card.created');

  let currentVersion = seeded.version;
  let lastObservedVersion = seeded.version;

  async function doUpdate(
    label: string,
    patch: { title?: string; body?: string | null },
    expect: (seen: CardUpdatedPayload) => string | null,
  ) {
    // Pre-arm BEFORE emit. The server bumps version by exactly one per
    // mutation, so expectedNext is deterministic.
    const expectedNext = currentVersion + 1;
    const seenP = armWait(
      b,
      'card.updated',
      (p) => p.cardId === seeded.id && p.newVersion === expectedNext,
    );

    const ack = await new Promise<{ ok: boolean; reason?: string; data?: CardUpdatedPayload }>(
      (resolve) => {
        a.emit(
          'card.update',
          { cardId: seeded.id, expectedVersion: currentVersion, ...patch },
          (r) => resolve(r as { ok: boolean; reason?: string; data?: CardUpdatedPayload }),
        );
      },
    );
    if (!ack.ok || !ack.data) {
      throw new Error(`[A] ${label} failed: ${ack.reason ?? 'no-ack'}`);
    }
    if (ack.data.newVersion !== expectedNext) {
      throw new Error(
        `[A] ${label}: expected ack v${expectedNext}, got v${ack.data.newVersion}`,
      );
    }
    currentVersion = ack.data.newVersion;
    console.log(`[A] ${label} → v${ack.data.newVersion}`);

    const seen = await seenP;
    if (seen.newVersion <= lastObservedVersion) {
      throw new Error(
        `[B] ${label}: non-monotonic version ${seen.newVersion} <= ${lastObservedVersion}`,
      );
    }
    lastObservedVersion = seen.newVersion;
    const failReason = expect(seen);
    if (failReason) throw new Error(`[B] ${label}: ${failReason}`);
    console.log(`[B] saw ${label} v${seen.newVersion}`);
  }

  // Phase 1 — rename
  await doUpdate(
    'title update',
    { title: 'edit-1' },
    (seen) => (seen.title === 'edit-1' ? null : `title not propagated: ${seen.title}`),
  );
  if (bState.get(seeded.id)?.title !== 'edit-1') {
    throw new Error('[B] state: title not applied');
  }

  // Phase 2 — body set
  await doUpdate(
    'body set',
    { body: 'body-1' },
    (seen) => (seen.body === 'body-1' ? null : `body not propagated: ${seen.body}`),
  );
  if (bState.get(seeded.id)?.body !== 'body-1') {
    throw new Error('[B] state: body not applied');
  }

  // Phase 3 — clear body + rename again in one call
  await doUpdate(
    'title+body(null)',
    { title: 'edit-3', body: null },
    (seen) => {
      if (seen.title !== 'edit-3') return `title not propagated: ${seen.title}`;
      if (seen.body !== null) return `body not cleared: ${JSON.stringify(seen.body)}`;
      return null;
    },
  );
  const final = bState.get(seeded.id);
  if (final?.title !== 'edit-3' || final.body !== null) {
    throw new Error('[B] state: title/body mismatch after combined update');
  }

  // Phase 4 — delete
  const deletedOnB = armWait(b, 'card.deleted', (p) => p.cardId === seeded.id);
  const delAck = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
    a.emit(
      'card.delete',
      { cardId: seeded.id, expectedVersion: currentVersion },
      (r) => resolve(r),
    );
  });
  if (!delAck.ok) throw new Error(`[A] delete failed: ${delAck.reason}`);
  console.log(`[A] deleted`);
  await deletedOnB;
  console.log('[B] saw card.deleted');
  if (bState.has(seeded.id)) {
    throw new Error("[B] state: card still present after delete");
  }

  // HTTP snapshot: authoritative DB view confirms the row is gone
  const res = await fetch(`${API_URL}/api/boards/${BOARD_ID}`);
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  const finalSnap = (await res.json()) as Snapshot;
  const stillThere = finalSnap.columns.some((c) =>
    c.cards.some((card) => card.id === seeded.id),
  );
  if (stillThere) throw new Error('HTTP snapshot still contains the deleted card');

  console.log('\nSMOKE PASS');
  a.close();
  b.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nSMOKE FAIL:', err.message);
  process.exit(1);
});
