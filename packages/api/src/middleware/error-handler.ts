// Express error-handling middleware. Translates typed errors to HTTP codes.
// Unknown errors are logged and returned as a generic 500 — never leaked
// as a stack trace to the client.

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from '../errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'not-found' });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'invalid', issues: err.issues });
  }
  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: 'not-found', message: err.message });
  }
  if (err instanceof ConflictError) {
    return res.status(409).json({ error: 'conflict', message: err.message });
  }
  if (err instanceof ForbiddenError) {
    return res.status(403).json({ error: 'forbidden', message: err.message });
  }
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: 'invalid', message: err.message });
  }
  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({ error: 'internal' });
}
