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

/** RFC 6749 error: `error` is the code (invalid_request, invalid_client, invalid_grant, unsupported_grant_type,
 *  invalid_redirect_uri, access_denied, invalid_token); the message is the human-readable description. */
export class OAuthError extends Error {
  constructor(readonly error: string, description: string, readonly status = 400) {
    super(description);
  }
}
