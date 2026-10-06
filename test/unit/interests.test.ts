import { describe, expect, it } from 'vitest';
import {
  MAX_INTEREST_LENGTH,
  MAX_INTERESTS,
  normalizeInterests,
} from '../../src/shared/interests.js';
import { ValidationError } from '../../src/shared/errors.js';

describe('normalizeInterests', () => {
  it('trims, lowercases, and removes duplicates while keeping first-seen order', () => {
    expect(normalizeInterests(['  Rust ', 'chess', 'RUST', 'Chess', 'go'])).toEqual([
      'rust',
      'chess',
      'go',
    ]);
  });

  it('collapses internal whitespace so "machine  learning" and "machine learning" match', () => {
    expect(normalizeInterests(['machine  learning', 'Machine\tLearning'])).toEqual([
      'machine learning',
    ]);
  });

  it('drops entries that are empty after trimming', () => {
    expect(normalizeInterests(['', '   ', 'jazz'])).toEqual(['jazz']);
  });

  it('accepts an empty list (clears interests)', () => {
    expect(normalizeInterests([])).toEqual([]);
  });

  it('rejects non-arrays and non-string entries', () => {
    expect(() => normalizeInterests('rust')).toThrow(ValidationError);
    expect(() => normalizeInterests([1, 'rust'])).toThrow(ValidationError);
    expect(() => normalizeInterests(null)).toThrow(ValidationError);
  });

  it(`rejects more than ${MAX_INTERESTS} distinct interests`, () => {
    const many = Array.from({ length: MAX_INTERESTS + 1 }, (_, i) => `topic-${i}`);
    expect(() => normalizeInterests(many)).toThrow(ValidationError);
    expect(normalizeInterests(many.slice(0, MAX_INTERESTS))).toHaveLength(MAX_INTERESTS);
  });

  it('counts the limit after removing duplicates', () => {
    const dupes = Array.from({ length: MAX_INTERESTS * 2 }, () => 'rust');
    expect(normalizeInterests(dupes)).toEqual(['rust']);
  });

  it(`rejects an interest longer than ${MAX_INTEREST_LENGTH} characters`, () => {
    expect(() => normalizeInterests(['x'.repeat(MAX_INTEREST_LENGTH + 1)])).toThrow(
      ValidationError,
    );
    expect(normalizeInterests(['x'.repeat(MAX_INTEREST_LENGTH)])).toHaveLength(1);
  });
});
