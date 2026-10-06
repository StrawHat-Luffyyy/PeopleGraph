import { describe, expect, it } from 'vitest';
import {
  decodeIdCursor,
  decodeSinceCursor,
  DEFAULT_PAGE_SIZE,
  encodeIdCursor,
  encodeSinceCursor,
  MAX_PAGE_SIZE,
  parseLimit,
} from '../../src/api/pagination.js';
import { ValidationError } from '../../src/shared/errors.js';

describe('parseLimit', () => {
  it('defaults when absent', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('accepts 1 through MAX_PAGE_SIZE', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit(String(MAX_PAGE_SIZE))).toBe(100);
  });

  it.each(['0', '101', '-1', '2.5', 'ten', '', ' 5', '1e2'])('rejects %j', (raw) => {
    expect(() => parseLimit(raw)).toThrow(ValidationError);
  });
});

describe('since cursor', () => {
  it('round-trips a nanosecond timestamp and an id exactly', () => {
    const cursor = { since: '2026-10-05T15:00:41.123456789Z', id: 'user_42' };
    expect(decodeSinceCursor(encodeSinceCursor(cursor))).toEqual(cursor);
  });

  it('is opaque url-safe text', () => {
    expect(encodeSinceCursor({ since: '2026-10-05T15:00:41.123Z', id: 'u-1' })).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });

  it.each([
    ['garbage', '!!!not-base64!!!'],
    ['not json', Buffer.from('hello').toString('base64url')],
    ['json array', Buffer.from('[1,2]').toString('base64url')],
    ['missing since', Buffer.from(JSON.stringify({ i: 'u1' })).toString('base64url')],
    ['non-string since', Buffer.from(JSON.stringify({ s: 5, i: 'u1' })).toString('base64url')],
    [
      'since not a datetime',
      Buffer.from(JSON.stringify({ s: 'yesterday', i: 'u1' })).toString('base64url'),
    ],
    [
      'bad id',
      Buffer.from(JSON.stringify({ s: '2026-10-05T15:00:41Z', i: "x' OR 1=1" })).toString(
        'base64url',
      ),
    ],
    ['id cursor given to since endpoint', encodeIdCursor('u1')],
  ])('rejects %s', (_label, raw) => {
    expect(() => decodeSinceCursor(raw)).toThrow(ValidationError);
  });

  it('returns null when absent', () => {
    expect(decodeSinceCursor(undefined)).toBeNull();
  });
});

describe('id cursor', () => {
  it('round-trips', () => {
    expect(decodeIdCursor(encodeIdCursor('abc-123'))).toBe('abc-123');
  });

  it('returns null when absent', () => {
    expect(decodeIdCursor(undefined)).toBeNull();
  });

  it.each([
    ['garbage', '%%%'],
    ['bad id', Buffer.from(JSON.stringify({ i: 'a b' })).toString('base64url')],
    [
      'since cursor given to id endpoint',
      encodeSinceCursor({ since: '2026-10-05T15:00:41Z', id: 'u1' }),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => decodeIdCursor(raw)).toThrow(ValidationError);
  });
});
