import { ValidationError } from '../shared/errors.js';
import { parseUserId } from './validation.js';

export const DEFAULT_PAGE_SIZE = 20;
/** Hard cap on any list endpoint (CLAUDE.md invariant 4). */
export const MAX_PAGE_SIZE = 100;

// UTC or fixed offset; up to nanosecond fractions, which Neo4j datetimes can carry.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export interface SinceCursor {
  /** ISO datetime of the edge's `since`, kept as text so nanoseconds survive. */
  since: string;
  id: string;
}

/** Parses `?limit=`. Endpoints with a tighter cap than MAX_PAGE_SIZE pass their own `max`. */
export function parseLimit(raw: string | undefined, max = MAX_PAGE_SIZE): number {
  if (raw === undefined) return Math.min(DEFAULT_PAGE_SIZE, max);
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ValidationError(`limit must be an integer between 1 and ${max}`);
  }
  return n;
}

function encode(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/** Decodes an opaque cursor into an object with exactly the expected keys, or throws. */
function decode(raw: string, keys: readonly string[]): Record<string, unknown> {
  const invalid = () => new ValidationError('cursor is invalid');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  if (actual.join() !== [...keys].sort().join()) throw invalid();
  return record;
}

function cursorId(value: unknown): string {
  try {
    return parseUserId(value);
  } catch {
    throw new ValidationError('cursor is invalid');
  }
}

/** Cursor for lists ordered by (since DESC, id DESC): followers, following. */
export function encodeSinceCursor(cursor: SinceCursor): string {
  return encode({ s: cursor.since, i: cursor.id });
}

export function decodeSinceCursor(raw: string | undefined): SinceCursor | null {
  if (raw === undefined) return null;
  const { s, i } = decode(raw, ['s', 'i']);
  if (typeof s !== 'string' || !ISO_DATETIME.test(s)) {
    throw new ValidationError('cursor is invalid');
  }
  return { since: s, id: cursorId(i) };
}

/** Cursor for lists ordered by id ASC: mutuals. */
export function encodeIdCursor(id: string): string {
  return encode({ i: id });
}

export function decodeIdCursor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  return cursorId(decode(raw, ['i']).i);
}
