import { ValidationError } from './errors.js';

export const MAX_INTERESTS = 50;
export const MAX_INTEREST_LENGTH = 64;

/**
 * Normalizes a user's interest list before it reaches the database: trim, collapse
 * whitespace, lowercase, drop empties, de-duplicate (first occurrence wins).
 * Limits apply after de-duplication so a list padded with repeats is still accepted.
 */
export function normalizeInterests(input: unknown): string[] {
  if (!Array.isArray(input)) throw new ValidationError('interests must be an array of strings');

  const seen = new Set<string>();
  for (const raw of input as unknown[]) {
    if (typeof raw !== 'string') {
      throw new ValidationError('interests must be an array of strings');
    }
    const name = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (name === '') continue;
    if (name.length > MAX_INTEREST_LENGTH) {
      throw new ValidationError(`each interest must be at most ${MAX_INTEREST_LENGTH} characters`);
    }
    seen.add(name);
  }

  if (seen.size > MAX_INTERESTS) {
    throw new ValidationError(`at most ${MAX_INTERESTS} interests are allowed`);
  }
  return [...seen];
}
