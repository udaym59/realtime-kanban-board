// Prisma client singleton. Services should accept a client as an argument
// (so they compose cleanly inside $transaction); this singleton is for the
// composition root and for scripts (seed, maintenance).
//
// Logs flow through the project's pino logger — `warn` and `error` events
// are forwarded so they land in the same structured log stream as HTTP
// requests.

import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger.js';

export const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
    { level: 'info', emit: 'event' },
  ],
});

prisma.$on('warn', (e) => logger.warn({ prisma: e }, 'prisma warn'));
// Note: this fires for EVERY query that throws, including P2002s we handle
// via retry in services/cards.ts. Keep at debug so retried errors don't
// masquerade as real failures in prod logs.
prisma.$on('error', (e) => logger.debug({ prisma: e }, 'prisma query error'));
prisma.$on('info', (e) => logger.debug({ prisma: e }, 'prisma info'));

// Graceful shutdown — called from server.ts on SIGTERM/SIGINT
export async function disconnectPrisma() {
  await prisma.$disconnect();
}
