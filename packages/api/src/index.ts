// Composition root. Express + socket.io sharing one http server; Postgres
// LISTEN/NOTIFY bridge drives fan-out to board rooms.

import 'dotenv/config';
import { createServer } from 'node:http';
import express from 'express';
import type { Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from 'shared';

import { logger } from './lib/logger.js';
import { disconnectPrisma } from './db/prisma.js';
import { createPgListener } from './db/listen.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { boardsRouter } from './routes/boards.js';
import { registerBoardSocket } from './sockets/board.js';
import { registerCardSockets } from './sockets/cards.js';

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

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: CORS_ORIGIN },
});

io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'socket connected');
  registerBoardSocket(io, socket);
  registerCardSockets(io, socket);
  socket.on('disconnect', (reason) => {
    logger.info({ socketId: socket.id, reason }, 'socket disconnected');
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
