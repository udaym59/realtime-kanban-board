import { describe, it, expect } from 'vitest';
import {
  BoardSchema,
  ColumnSchema,
  CardSchema,
  BoardSnapshotSchema,
  SubscribeBoardMessage,
  CreateCardMessage,
  MoveCardMessage,
  CreateColumnMessage,
  RenameColumnMessage,
} from './schemas.js';
import { NotifyPayloadSchema } from './events.js';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';
const UUID_C = '00000000-0000-4000-8000-000000000003';
const NOW = '2026-11-03T06:00:00.000Z';

describe('CardSchema', () => {
  it('parses a valid card', () => {
    const r = CardSchema.safeParse({
      id: UUID_A,
      columnId: UUID_B,
      title: 'Draft the ADR',
      body: null,
      position: 'a0',
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty title', () => {
    const r = CardSchema.safeParse({
      id: UUID_A,
      columnId: UUID_B,
      title: '',
      body: null,
      position: 'a0',
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(r.success).toBe(false);
  });
});

describe('ColumnSchema', () => {
  it('parses a valid column', () => {
    const r = ColumnSchema.safeParse({
      id: UUID_A,
      boardId: UUID_B,
      name: 'Todo',
      position: 'a0',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty position (DB CHECK invariant mirror)', () => {
    const r = ColumnSchema.safeParse({
      id: UUID_A,
      boardId: UUID_B,
      name: 'Todo',
      position: '',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(r.success).toBe(false);
  });
});

describe('BoardSchema', () => {
  it('parses a valid board', () => {
    const r = BoardSchema.safeParse({
      id: UUID_A,
      name: 'Demo',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-ISO datetime', () => {
    const r = BoardSchema.safeParse({
      id: UUID_A,
      name: 'Demo',
      createdAt: '2026-11-03',
      updatedAt: NOW,
    });
    expect(r.success).toBe(false);
  });
});

describe('BoardSnapshotSchema', () => {
  it('parses a nested snapshot', () => {
    const r = BoardSnapshotSchema.safeParse({
      id: UUID_A,
      name: 'Demo',
      createdAt: NOW,
      updatedAt: NOW,
      columns: [
        {
          id: UUID_B,
          boardId: UUID_A,
          name: 'Todo',
          position: 'a0',
          createdAt: NOW,
          updatedAt: NOW,
          cards: [],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects when a column is missing its cards array', () => {
    const r = BoardSnapshotSchema.safeParse({
      id: UUID_A,
      name: 'Demo',
      createdAt: NOW,
      updatedAt: NOW,
      columns: [
        {
          id: UUID_B,
          boardId: UUID_A,
          name: 'Todo',
          position: 'a0',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('MoveCardMessage', () => {
  it('parses a valid move with both neighbors', () => {
    const r = MoveCardMessage.safeParse({
      cardId: UUID_A,
      toColumnId: UUID_B,
      afterCardId: UUID_C,
      beforeCardId: null,
      expectedVersion: 3,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a negative expectedVersion', () => {
    const r = MoveCardMessage.safeParse({
      cardId: UUID_A,
      toColumnId: UUID_B,
      afterCardId: null,
      beforeCardId: null,
      expectedVersion: -1,
    });
    expect(r.success).toBe(false);
  });
});

describe('CreateCardMessage', () => {
  it('parses a valid create', () => {
    const r = CreateCardMessage.safeParse({ columnId: UUID_A, title: 'Hi' });
    expect(r.success).toBe(true);
  });
  it('rejects a bad columnId', () => {
    const r = CreateCardMessage.safeParse({ columnId: 'not-a-uuid', title: 'Hi' });
    expect(r.success).toBe(false);
  });
});

describe('CreateColumnMessage', () => {
  it('parses a valid create', () => {
    const r = CreateColumnMessage.safeParse({ boardId: UUID_A, name: 'Todo' });
    expect(r.success).toBe(true);
  });
  it('rejects an overlong name', () => {
    const r = CreateColumnMessage.safeParse({
      boardId: UUID_A,
      name: 'x'.repeat(101),
    });
    expect(r.success).toBe(false);
  });
});

describe('RenameColumnMessage', () => {
  it('parses a valid rename', () => {
    const r = RenameColumnMessage.safeParse({ columnId: UUID_A, name: 'Doing' });
    expect(r.success).toBe(true);
  });
  it('rejects an empty name', () => {
    const r = RenameColumnMessage.safeParse({ columnId: UUID_A, name: '' });
    expect(r.success).toBe(false);
  });
});

describe('SubscribeBoardMessage', () => {
  it('parses', () => {
    const r = SubscribeBoardMessage.safeParse({ boardId: UUID_A });
    expect(r.success).toBe(true);
  });
  it('rejects missing boardId', () => {
    const r = SubscribeBoardMessage.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe('NotifyPayloadSchema', () => {
  it('parses a card.moved payload', () => {
    const r = NotifyPayloadSchema.safeParse({
      type: 'card.moved',
      boardId: UUID_A,
      data: {
        cardId: UUID_B,
        toColumnId: UUID_C,
        newPosition: 'a1V',
        newVersion: 4,
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown event type (closed discriminated union)', () => {
    const r = NotifyPayloadSchema.safeParse({
      type: 'card.exploded',
      boardId: UUID_A,
      data: {},
    });
    expect(r.success).toBe(false);
  });
});

// v1.1 — card detail editing shapes
import {
  UpdateCardMessage,
  DeleteCardMessage,
} from './schemas.js';

describe('UpdateCardMessage', () => {
  it('parses a title-only update', () => {
    const r = UpdateCardMessage.safeParse({
      cardId: UUID_A,
      title: 'New title',
      expectedVersion: 2,
    });
    expect(r.success).toBe(true);
  });

  it('parses a body-only update (including explicit null to clear)', () => {
    const r = UpdateCardMessage.safeParse({
      cardId: UUID_A,
      body: null,
      expectedVersion: 2,
    });
    expect(r.success).toBe(true);
  });

  it('rejects when both title and body are omitted', () => {
    const r = UpdateCardMessage.safeParse({
      cardId: UUID_A,
      expectedVersion: 2,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an empty title (DB invariant)', () => {
    const r = UpdateCardMessage.safeParse({
      cardId: UUID_A,
      title: '',
      expectedVersion: 2,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an overlong body', () => {
    const r = UpdateCardMessage.safeParse({
      cardId: UUID_A,
      body: 'x'.repeat(10_001),
      expectedVersion: 2,
    });
    expect(r.success).toBe(false);
  });
});

describe('DeleteCardMessage', () => {
  it('parses a valid delete', () => {
    const r = DeleteCardMessage.safeParse({
      cardId: UUID_A,
      expectedVersion: 3,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a negative expectedVersion', () => {
    const r = DeleteCardMessage.safeParse({
      cardId: UUID_A,
      expectedVersion: -1,
    });
    expect(r.success).toBe(false);
  });
});

describe('NotifyPayloadSchema — v1.1 variants', () => {
  it('parses a card.updated payload with partial fields', () => {
    const r = NotifyPayloadSchema.safeParse({
      type: 'card.updated',
      boardId: UUID_A,
      data: {
        cardId: UUID_B,
        newVersion: 5,
        title: 'Refined',
      },
    });
    expect(r.success).toBe(true);
  });

  it('parses a card.updated payload with body=null (cleared)', () => {
    const r = NotifyPayloadSchema.safeParse({
      type: 'card.updated',
      boardId: UUID_A,
      data: { cardId: UUID_B, newVersion: 6, body: null },
    });
    expect(r.success).toBe(true);
  });

  it('parses a card.deleted payload', () => {
    const r = NotifyPayloadSchema.safeParse({
      type: 'card.deleted',
      boardId: UUID_A,
      data: { cardId: UUID_B },
    });
    expect(r.success).toBe(true);
  });
});
