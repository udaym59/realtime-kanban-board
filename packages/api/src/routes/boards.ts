import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { getSnapshot } from '../services/boards.js';

export const boardsRouter = Router();

const IdParams = z.object({ id: z.uuid() });

boardsRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = IdParams.parse(req.params);
    const snapshot = await getSnapshot(prisma, id);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});
