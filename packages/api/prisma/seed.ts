// Seed the demo board + default columns.
//
// Idempotent: safe to run on every deploy. Uses upsert on the board, and only
// seeds columns if the board has none (so renaming columns in prod won't be
// reverted by a redeploy).
//
// Runs via `pnpm --filter api db:seed` → `prisma db seed` → tsx prisma/seed.ts

import { PrismaClient } from '@prisma/client';
import { generateNKeysBetween } from 'fractional-indexing';

const prisma = new PrismaClient();

const DEMO_BOARD_ID = process.env.DEMO_BOARD_ID;
if (!DEMO_BOARD_ID) {
  console.error('DEMO_BOARD_ID is not set — add it to packages/api/.env');
  process.exit(1);
}

const DEFAULT_COLUMNS = ['Todo', 'Doing', 'Done'] as const;

async function main() {
  // 1. Upsert the board — survives re-runs without clobbering updatedAt churn
  const board = await prisma.board.upsert({
    where: { id: DEMO_BOARD_ID },
    create: { id: DEMO_BOARD_ID, name: 'Demo Board' },
    update: {}, // no-op: don't rename on redeploy
  });

  // 2. Columns — only if the board has none
  const columnCount = await prisma.column.count({
    where: { boardId: board.id },
  });

  if (columnCount === 0) {
    const positions = generateNKeysBetween(null, null, DEFAULT_COLUMNS.length);
    await prisma.column.createMany({
      data: DEFAULT_COLUMNS.map((name, i) => ({
        boardId: board.id,
        name,
        position: positions[i]!,
      })),
    });
    console.log(`seeded ${DEFAULT_COLUMNS.length} columns on board ${board.id}`);
  } else {
    console.log(`board ${board.id} already has ${columnCount} columns — no change`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
