// Two-client concurrent-move smoke (plan P4.3).
//
// Setup: both clients subscribe to the demo board. Ensures at least
// N_MOVES_PER_CLIENT * 2 cards exist (seeds if not).
//
// Each client performs N random moves on its own disjoint slice of cards
// into randomly chosen columns, appending to each target column's end.
// Multiple clients targeting the same column at the same time stress the
// P2002 retry path.
//
// Pass condition:
//   - Every move either succeeded or returned {ok: false, reason: 'conflict'}
//   - No `other` reasons leaked
//   - Final HTTP snapshot's card set matches both clients' event-reconstructed
//     view for every card both clients observed
//
// Run: pnpm --filter api smoke:move (API must already be running)

import 'dotenv/config';
import { io as makeClient, type Socket } from 'socket.io-client';
import type {
  Card,
  Column,
  ClientToServerEvents,
  ServerToClientEvents,
} from 'shared';

const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const BOARD_ID = process.env.DEMO_BOARD_ID;
if (!BOARD_ID) throw new Error('DEMO_BOARD_ID not set');
const N_MOVES_PER_CLIENT = Number(process.env.SMOKE_N ?? 10);

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

async function fetchSnapshot(boardId: string): Promise<Snapshot> {
  const res = await fetch(`${API_URL}/api/boards/${boardId}`);
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  return (await res.json()) as Snapshot;
}

function flattenCards(snap: Snapshot): Card[] {
  return snap.columns.flatMap((c) => c.cards);
}

async function ensureCards(a: Client, snap: Snapshot, needed: number): Promise<Snapshot> {
  let current = flattenCards(snap).length;
  const col0 = snap.columns[0]!;
  while (current < needed) {
    const r = await new Promise<{ ok: boolean; card?: Card; reason?: string }>((resolve) =>
      a.emit(
        'card.create',
        { columnId: col0.id, title: `smoke-move-${Date.now()}-${current}` },
        (res) =>
          res.ok ? resolve({ ok: true, card: res.data.card }) : resolve({ ok: false, reason: res.reason }),
      ),
    );
    if (!r.ok) throw new Error(`seed create failed: ${r.reason}`);
    current++;
  }
  return fetchSnapshot(BOARD_ID!);
}

async function main() {
  const a = await connect('A');
  const b = await connect('B');

  const initial = await subscribe(a, BOARD_ID!);
  await subscribe(b, BOARD_ID!);

  const needed = N_MOVES_PER_CLIENT * 2;
  const seeded = await ensureCards(a, initial, needed);
  const cards = flattenCards(seeded);
  console.log(`using ${cards.length} cards across ${seeded.columns.length} columns`);

  // Track each client's view of card state via card.moved events
  const stateA = new Map<string, { columnId: string; position: string; version: number }>();
  const stateB = new Map<string, { columnId: string; position: string; version: number }>();
  for (const c of cards) {
    const v = { columnId: c.columnId, position: c.position, version: c.version };
    stateA.set(c.id, { ...v });
    stateB.set(c.id, { ...v });
  }
  a.on('card.moved', (p) => {
    stateA.set(p.cardId, { columnId: p.toColumnId, position: p.newPosition, version: p.newVersion });
  });
  b.on('card.moved', (p) => {
    stateB.set(p.cardId, { columnId: p.toColumnId, position: p.newPosition, version: p.newVersion });
  });

  // Disjoint slices so we're measuring same-column collision, not same-card
  const slice = (start: number) => cards.slice(start, start + N_MOVES_PER_CLIENT);
  const cardsForA = slice(0);
  const cardsForB = slice(N_MOVES_PER_CLIENT);

  let ok = 0;
  let conflict = 0;
  let other = 0;
  const otherReasons: string[] = [];

  // Pick afterCardId as the *last* card currently in the target column
  // according to the client's local view. Mirrors how a real @dnd-kit drop
  // computes neighbors, and gives the retry loop non-colliding inputs by
  // construction (each client's view of 'last' can differ under concurrency).
  function lastInColumn(
    state: Map<string, { columnId: string; position: string; version: number }>,
    columnId: string,
    excludeCardId: string,
  ): string | null {
    let best: { id: string; position: string } | null = null;
    for (const [id, s] of state) {
      if (id === excludeCardId) continue;
      if (s.columnId !== columnId) continue;
      if (!best || s.position > best.position) best = { id, position: s.position };
    }
    return best?.id ?? null;
  }

  async function doMove(
    sock: Client,
    state: Map<string, { columnId: string; position: string; version: number }>,
    card: Card,
    label: string,
  ) {
    const target = seeded.columns[Math.floor(Math.random() * seeded.columns.length)]!;
    const afterCardId = lastInColumn(state, target.id, card.id);
    return new Promise<void>((resolve) => {
      sock.emit(
        'card.move',
        {
          cardId: card.id,
          toColumnId: target.id,
          afterCardId,          // append after the current last (per local view)
          beforeCardId: null,
          expectedVersion: card.version,
        },
        (r) => {
          if (r.ok) ok++;
          else if (r.reason === 'conflict') conflict++;
          else {
            other++;
            otherReasons.push(`${label} ${card.id} → ${r.reason}: ${r.message ?? ''}`);
          }
          resolve();
        },
      );
    });
  }

  console.log(`firing ${N_MOVES_PER_CLIENT * 2} concurrent moves...`);
  const start = Date.now();
  await Promise.all([
    ...cardsForA.map((c) => doMove(a, stateA, c, 'A')),
    ...cardsForB.map((c) => doMove(b, stateB, c, 'B')),
  ]);
  console.log(`moves settled in ${Date.now() - start}ms`);

  // Let the bridge finish fanning out
  await new Promise((r) => setTimeout(r, 500));

  // Verify: final DB state matches both clients' event-reconstructed state
  const finalSnap = await fetchSnapshot(BOARD_ID!);
  const finalByCardId = new Map<string, Card>(flattenCards(finalSnap).map((c) => [c.id, c]));

  let diverge = 0;
  for (const [id, actual] of finalByCardId.entries()) {
    const seenA = stateA.get(id);
    const seenB = stateB.get(id);
    if (
      seenA &&
      (seenA.columnId !== actual.columnId || seenA.position !== actual.position)
    ) {
      diverge++;
      console.log(
        `A diverges on ${id}: saw col=${seenA.columnId} pos=${seenA.position}; actual col=${actual.columnId} pos=${actual.position}`,
      );
    }
    if (
      seenB &&
      (seenB.columnId !== actual.columnId || seenB.position !== actual.position)
    ) {
      diverge++;
      console.log(
        `B diverges on ${id}: saw col=${seenB.columnId} pos=${seenB.position}; actual col=${actual.columnId} pos=${actual.position}`,
      );
    }
  }

  console.log(`\nmove outcomes: ok=${ok} conflict=${conflict} other=${other}`);
  if (otherReasons.length) console.log(otherReasons.join('\n'));
  console.log(`final divergence: ${diverge}`);

  const pass = other === 0 && diverge === 0 && ok + conflict === N_MOVES_PER_CLIENT * 2;
  console.log(pass ? '\nSMOKE PASS' : '\nSMOKE FAIL');

  a.close();
  b.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
