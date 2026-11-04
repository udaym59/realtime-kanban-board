// Board read path. Takes the Prisma client as an argument per CLAUDE.md
// discipline — composes cleanly inside $transaction and is trivially mockable.
//
// Returns the ISO-string-flattened shape that matches
// `BoardSnapshotSchema` from shared/schemas.ts, so the HTTP route and socket
// ack can send it straight through.

import type { PrismaClient } from '@prisma/client';
import type { BoardSnapshot } from 'shared';
import { NotFoundError } from '../errors.js';

export async function getSnapshot(
  prisma: PrismaClient,
  boardId: string,
): Promise<BoardSnapshot> {
  const board = await prisma.board.findUnique({
    where: { id: boardId },
    include: {
      columns: {
        orderBy: { position: 'asc' },
        include: {
          cards: { orderBy: { position: 'asc' } },
        },
      },
    },
  });

  if (!board) throw new NotFoundError(`board ${boardId}`);

  // Normalize Date → ISO strings (BoardSnapshotSchema expects z.iso.datetime())
  return {
    id: board.id,
    name: board.name,
    createdAt: board.createdAt.toISOString(),
    updatedAt: board.updatedAt.toISOString(),
    columns: board.columns.map((c) => ({
      id: c.id,
      boardId: c.boardId,
      name: c.name,
      position: c.position,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      cards: c.cards.map((card) => ({
        id: card.id,
        columnId: card.columnId,
        title: card.title,
        body: card.body,
        position: card.position,
        version: card.version,
        createdAt: card.createdAt.toISOString(),
        updatedAt: card.updatedAt.toISOString(),
      })),
    })),
  };
}
