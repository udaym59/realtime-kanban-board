// Typed error classes. Services throw these; the HTTP error-handler
// middleware and socket handlers translate them to the response shape.
//
// Each class carries a stable `name` so `instanceof` works across the
// workspace boundary even if two copies of the file exist (shouldn't,
// but defense in depth).

export class NotFoundError extends Error {
  // `what` is the full locator kept on the instance for logs
  // (e.g. "card <uuid>", "column <uuid>"). The thrown Error's message
  // is trimmed to just the entity type so that when a socket handler
  // forwards it as the ack.message, a user never sees a raw UUID.
  // The id is still in logger context via { cardId, boardId } etc.
  constructor(public what: string) {
    const entity = what.split(' ')[0] ?? what;
    super(`${entity} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string, public context?: Record<string, unknown>) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ForbiddenError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends Error {
  constructor(public reason: string, public issues?: unknown) {
    super(reason);
    this.name = 'ValidationError';
  }
}
