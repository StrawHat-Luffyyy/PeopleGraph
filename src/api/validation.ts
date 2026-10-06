import { ValidationError } from '../shared/errors.js';

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HANDLE = /^[a-z0-9_]{3,30}$/;
const MAX_NAME_LENGTH = 100;

export interface CreateUserInput {
  id: string;
  handle: string;
  name: string;
}

export function parseUserId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !USER_ID.test(value)) {
    throw new ValidationError(`${field} must be 1-64 characters of A-Z, a-z, 0-9, _ or -`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a create-user body. Error messages name fields but never echo values (PII). */
export function parseCreateUser(body: unknown): CreateUserInput {
  if (!isRecord(body)) throw new ValidationError('body must be a JSON object');

  const id = parseUserId(body.id);

  const handle = typeof body.handle === 'string' ? body.handle.toLowerCase() : undefined;
  if (handle === undefined || !HANDLE.test(handle)) {
    throw new ValidationError('handle must be 3-30 characters of a-z, 0-9 or _');
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '' || name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`,
    );
  }

  return { id, handle, name };
}
