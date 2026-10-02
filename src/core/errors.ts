// Domain errors. The HTTP layer maps them to status codes; nothing here knows about HTTP.

export type ErrorCode =
  | 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited';

const STATUS: Record<ErrorCode, number> = {
  validation: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429,
};

export class AppError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
  get status(): number { return STATUS[this.code]; }
}

export const invalid = (message: string): never => { throw new AppError('validation', message); };
export const notFound = (what: string): never => { throw new AppError('not_found', `${what} not found`); };
