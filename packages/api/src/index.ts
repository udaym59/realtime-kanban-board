// Composition root. Express + socket.io sharing one http server; Postgres
// LISTEN/NOTIFY bridge drives card-event fan-out to board rooms.
//
// v1.2 (ADR 004): socket.io Server is now generic over SocketData carrying
// a guest identity. Identity is minted on `connection` BEFORE any handlers
// are registered so every handler can rely on socket.data being populated.
// Presence events bypass pg_notify by design — see ADR 004.

import 'dotenv/config';
import { createServer } from 'node:http';
import express from 'express';
import type { Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from 'shared';

import { logger } from './lib/logger.js';
import { disconnectPrisma } from './db/prisma.js';
import { createPgListener } from './db/listen.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { boardsRouter } from './routes/boards.js';
import { makeGuest } from './presence/identity.js';
import { registerBoardSocket } from './sockets/board.js';
import { registerCardSockets } from './sockets/cards.js';
import { registerPresenceSockets } from './sockets/presence.js';

const PORT = Number(process.env.PORT ?? 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

const app = express();
app.set('trust proxy', 1);

app.use(pinoHttp({ logger }));
app.use(express.json({ limit: '100kb' }));

// Simple single-origin CORS allow-list
app.use((req: Request, res: Response, next) => {
  if (req.headers.origin === CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.use('/api/boards', boardsRouter);
app.use(notFoundHandler);
app.use(errorHandler);

const httpServer = createServer(app);

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: { origin: CORS_ORIGIN },
});

io.on('connection', (socket) => {
  // Mint the guest identity FIRST — every handler below assumes it's set.
  // Lifetime = this socket; a reconnect creates a fresh guest (ADR 004).
  const guest = makeGuest();
  socket.data.guestId = guest.guestId;
  socket.data.name = guest.name;
  socket.data.color = guest.color;

  logger.info(
    { socketId: socket.id, guestId: guest.guestId, name: guest.name },
    'socket connected',
  );

  // Tell the client who they are so they can render their own avatar + label
  socket.emit('presence.self', guest);

  registerBoardSocket(io, socket);
  registerCardSockets(io, socket);
  // Presence last — it owns the 'disconnect' handler for leave broadcasts.
  // Multiple 'disconnect' listeners are fine (socket.io emits to all), but
  // keeping it adjacent to the register call makes the lifecycle legible.
  registerPresenceSockets(io, socket);

  socket.on('disconnect', (reason) => {
    logger.info(
      { socketId: socket.id, guestId: socket.data.guestId, reason },
      'socket disconnected',
    );
  });
});

// Postgres LISTEN/NOTIFY bridge — must be running before clients subscribe,
// otherwise early notifications are lost.
const listener = createPgListener(io);
listener.start().catch((err) => {
  logger.fatal({ err }, 'listen: initial connect failed');
  process.exit(1);
});

httpServer.listen(PORT, () => {
  logger.info({ port: PORT, cors: CORS_ORIGIN }, 'api listening');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await listener.stop();
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await disconnectPrisma();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
