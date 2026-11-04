// Two-client smoke for the full fan-out path (plan P3.3 acceptance).
//
// Spawns two socket.io-client instances subscribed to the demo board. One
// client creates N cards; both clients must observe each card.created event.
// Asserts both inboxes end up with identical event sets.
//
// Run: pnpm --filter api smoke:create
//      (ensure the API is already running: pnpm --filter api dev)

import 'dotenv/config';
import { io as makeClient, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared';

const API_URL = process.env.SMOKE_API_URL ?? 'http://localhost:3001';
const BOARD_ID = process.env.DEMO_BOARD_ID;
if (!BOARD_ID) throw new Error('DEMO_BOARD_ID not set');

const N_CARDS = Number(process.env.SMOKE_N ?? 10);

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

function connect(label: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock: Client = makeClient(API_URL, { transports: ['websocket'] });
    sock.on('connect', () => {
      console.log(`[${label}] connected (${sock.id})`);
      resolve(sock);
    });
    sock.on('connect_error', reject);
  });
}

function subscribe(sock: Client, label: string, boardId: string) {
  return new Promise<void>((resolve, reject) => {
    sock.emit('board.subscribe', { boardId }, (r) => {
      if (!r.ok) return reject(new Error(`${label} subscribe failed: ${r.reason}`));
      console.log(
        `[${label}] subscribed — ${r.data.columns.length} columns, ` +
          `${r.data.columns.reduce((n, c) => n + c.cards.length, 0)} existing cards`,
      );
      resolve();
    });
  });
}

async function main() {
  const a = await connect('A');
  const b = await connect('B');

  await subscribe(a, 'A', BOARD_ID!);
  await subscribe(b, 'B', BOARD_ID!);

  const seenA: string[] = [];
  const seenB: string[] = [];
  a.on('card.created', ({ card }) => seenA.push(card.id));
  b.on('card.created', ({ card }) => seenB.push(card.id));

  // Pick an existing column
  const snap = await new Promise<{ columns: { id: string }[] }>((resolve, reject) =>
    a.emit('board.subscribe', { boardId: BOARD_ID! }, (r) =>
      r.ok ? resolve({ columns: r.data.columns }) : reject(new Error(r.reason)),
    ),
  );
  const columnId = snap.columns[0]!.id;

  console.log(`creating ${N_CARDS} cards from A into column ${columnId}...`);
  const createdIds: string[] = [];
  for (let i = 0; i < N_CARDS; i++) {
    const r = await new Promise<{ ok: boolean; id?: string; reason?: string }>((resolve) =>
      a.emit('card.create', { columnId, title: `smoke-${Date.now()}-${i}` }, (res) =>
        res.ok ? resolve({ ok: true, id: res.data.card.id }) : resolve({ ok: false, reason: res.reason }),
      ),
    );
    if (!r.ok) throw new Error(`create ${i} failed: ${r.reason}`);
    createdIds.push(r.id!);
  }

  // Give the bridge a tick to flush all notifications
  await new Promise((r) => setTimeout(r, 500));

  const sortedCreated = [...createdIds].sort();
  const sortedA = [...seenA].sort();
  const sortedB = [...seenB].sort();

  // A should see its own creates via the bridge (io.to — includes sender)
  // B should see them too
  const okA = JSON.stringify(sortedA.slice(-N_CARDS)) === JSON.stringify(sortedCreated);
  const okB = JSON.stringify(sortedB.slice(-N_CARDS)) === JSON.stringify(sortedCreated);

  console.log(`A saw ${seenA.length} card.created events`);
  console.log(`B saw ${seenB.length} card.created events`);
  console.log(okA && okB ? '\nSMOKE PASS' : '\nSMOKE FAIL');

  a.close();
  b.close();
  process.exit(okA && okB ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
