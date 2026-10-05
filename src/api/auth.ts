import { createMiddleware } from 'hono/factory';
import { UnauthorizedError, ValidationError } from '../shared/errors.js';
import { parseUserId } from './validation.js';

export interface AuthVariables {
  userId: string;
}

/**
 * Development auth: the caller's id comes from the X-User-Id header. Replaced by JWT
 * verification in Phase 8; routes only ever read `c.get('userId')`.
 */
export const requireUser = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  try {
    c.set('userId', parseUserId(c.req.header('x-user-id'), 'X-User-Id'));
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new UnauthorizedError('X-User-Id header is missing or malformed');
    }
    throw err;
  }
  await next();
});
