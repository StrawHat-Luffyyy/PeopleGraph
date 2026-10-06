/** Base class for errors the service raises on purpose (as opposed to bugs). */
export class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid or missing configuration. Lists every problem so startup fails once, not per field. */
export class ConfigError extends AppError {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * An error that maps directly to an HTTP response. Messages are shown to clients,
 * so they must never contain PII or internal details.
 */
export abstract class HttpError extends AppError {
  abstract readonly status: 400 | 401 | 403 | 404 | 409;
  abstract readonly code: string;
}

export class ValidationError extends HttpError {
  readonly status = 400;
  readonly code = 'invalid_request';
}

export class UnauthorizedError extends HttpError {
  readonly status = 401;
  readonly code = 'unauthorized';
}

export class ForbiddenError extends HttpError {
  readonly status = 403;
  readonly code = 'forbidden';
}

export class NotFoundError extends HttpError {
  readonly status = 404;
  readonly code = 'not_found';
}

export class ConflictError extends HttpError {
  readonly status = 409;
  readonly code = 'conflict';
}
