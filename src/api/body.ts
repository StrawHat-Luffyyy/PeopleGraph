import type { Context } from 'hono';
import { ValidationError } from '../shared/errors.js';

/** Parses the JSON body, turning malformed JSON into a 400 instead of a 500. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json<unknown>();
  } catch {
    throw new ValidationError('body must be valid JSON');
  }
}
