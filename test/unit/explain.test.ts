import { describe, expect, it } from 'vitest';
import { explain } from '../../src/reco/explain.js';
import type { ScoredCandidate } from '../../src/reco/types.js';

const base: ScoredCandidate = {
  id: 'c1',
  score: 0,
  mutualCount: 0,
  sampleMutuals: [],
  sharedInterests: 0,
  sampleInterests: [],
  followsYou: false,
};
const withMutuals = (count: number, sample: string[]) =>
  explain({ ...base, mutualCount: count, sampleMutuals: sample });

describe('explain: mutuals', () => {
  it.each([
    [1, ['ana'], 'followed by ana'],
    [2, ['ana', 'raj'], 'followed by ana and raj'],
    [3, ['ana', 'kim', 'raj'], 'followed by ana, kim and raj'],
    [4, ['ana', 'kim', 'raj'], 'followed by ana, kim and 2 others'],
    [7, ['ana', 'kim', 'raj'], 'followed by ana, kim and 5 others'],
  ])('%i mutual(s) -> %j', (count, sample, text) => {
    expect(withMutuals(count, sample).explanation).toBe(text);
  });

  it('uses "1 other" (singular) when exactly one name is left out', () => {
    // A short sample (2 handles) for a count of 3 still reads naturally.
    expect(withMutuals(3, ['ana', 'kim']).explanation).toBe('followed by ana, kim and 1 other');
  });

  it('falls back to a count when no handles were sampled', () => {
    expect(withMutuals(4, []).explanation).toBe('followed by 4 people you follow');
    expect(withMutuals(1, []).explanation).toBe('followed by 1 person you follow');
  });

  it('returns a structured reason', () => {
    expect(withMutuals(2, ['ana', 'raj']).reasons).toEqual([
      { type: 'mutuals', count: 2, sample: ['ana', 'raj'] },
    ]);
  });
});

describe('explain: interests', () => {
  const withInterests = (count: number, sample: string[]) =>
    explain({ ...base, sharedInterests: count, sampleInterests: sample }).explanation;

  it.each([
    [1, ['rust'], 'shares an interest: rust'],
    [2, ['chess', 'rust'], 'shares interests: chess, rust'],
    [3, ['chess', 'go', 'rust'], 'shares interests: chess, go, rust'],
    [5, ['chess', 'go', 'rust'], 'shares interests: chess, go, rust and 2 more'],
  ])('%i interest(s) -> %j', (count, sample, text) => {
    expect(withInterests(count, sample)).toBe(text);
  });
});

describe('explain: combinations', () => {
  it('says "follows you"', () => {
    const result = explain({ ...base, followsYou: true });
    expect(result).toEqual({ reasons: [{ type: 'follows_you' }], explanation: 'follows you' });
  });

  it('joins all reasons in a fixed order: mutuals, interests, follows you', () => {
    const result = explain({
      ...base,
      followsYou: true,
      mutualCount: 1,
      sampleMutuals: ['ana'],
      sharedInterests: 1,
      sampleInterests: ['rust'],
    });
    expect(result.explanation).toBe('followed by ana; shares an interest: rust; follows you');
    expect(result.reasons.map((r) => r.type)).toEqual(['mutuals', 'interests', 'follows_you']);
  });

  it('has no reasons and empty text for a candidate with no signals', () => {
    expect(explain(base)).toEqual({ reasons: [], explanation: '' });
  });
});
