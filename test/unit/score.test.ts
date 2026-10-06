import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { scoreCandidates } from '../../src/reco/score.js';
import type { CandidateSources, Weights } from '../../src/reco/types.js';

const weights: Weights = { mutual: 3, interest: 2, followsYou: 5 };
const empty: CandidateSources = { mutuals: [], interests: [], followsYou: [] };

describe('scoreCandidates', () => {
  it('returns nothing for no candidates', () => {
    expect(scoreCandidates(empty, weights)).toEqual([]);
  });

  it('computes the weighted sum for a single source', () => {
    const [c] = scoreCandidates(
      { ...empty, mutuals: [{ id: 'c1', mutualCount: 3, sampleMutuals: ['a', 'b', 'c'] }] },
      weights,
    );
    expect(c).toEqual({
      id: 'c1',
      score: 9,
      mutualCount: 3,
      sampleMutuals: ['a', 'b', 'c'],
      sharedInterests: 0,
      sampleInterests: [],
      followsYou: false,
    });
  });

  it('merges one candidate seen by all three sources into one entry', () => {
    const scored = scoreCandidates(
      {
        mutuals: [{ id: 'c1', mutualCount: 2, sampleMutuals: ['ana', 'raj'] }],
        interests: [{ id: 'c1', sharedInterests: 1, sampleInterests: ['rust'] }],
        followsYou: [{ id: 'c1' }],
      },
      weights,
    );
    expect(scored).toHaveLength(1);
    expect(scored[0]).toMatchObject({
      score: 3 * 2 + 2 * 1 + 5,
      mutualCount: 2,
      sharedInterests: 1,
      sampleInterests: ['rust'],
      followsYou: true,
    });
  });

  it('ranks by score descending, then id ascending on ties', () => {
    const scored = scoreCandidates(
      {
        mutuals: [
          { id: 'c2', mutualCount: 1, sampleMutuals: ['x'] }, // 3
          { id: 'c1', mutualCount: 3, sampleMutuals: ['x', 'y', 'z'] }, // 9
        ],
        interests: [
          { id: 'c3', sharedInterests: 2, sampleInterests: ['a', 'b'] }, // 4
          { id: 'b9', sharedInterests: 2, sampleInterests: ['a', 'b'] }, // 4, ties c3
        ],
        followsYou: [{ id: 'c4' }], // 5
      },
      weights,
    );
    expect(scored.map((c) => [c.id, c.score])).toEqual([
      ['c1', 9],
      ['c4', 5],
      ['b9', 4],
      ['c3', 4],
      ['c2', 3],
    ]);
  });

  it('applies the given weights (all zero means everything ties, ordered by id)', () => {
    const scored = scoreCandidates(
      {
        mutuals: [{ id: 'z', mutualCount: 5, sampleMutuals: [] }],
        interests: [],
        followsYou: [{ id: 'a' }],
      },
      { mutual: 0, interest: 0, followsYou: 0 },
    );
    expect(scored.map((c) => [c.id, c.score])).toEqual([
      ['a', 0],
      ['z', 0],
    ]);
  });

  it('does not mutate its input', () => {
    const sources: CandidateSources = {
      mutuals: [{ id: 'c1', mutualCount: 1, sampleMutuals: ['x'] }],
      interests: [{ id: 'c1', sharedInterests: 1, sampleInterests: ['y'] }],
      followsYou: [],
    };
    const copy = structuredClone(sources);
    scoreCandidates(sources, weights);
    expect(sources).toEqual(copy);
  });
});

// Property tests: invariants that must hold for any input, not just the examples above.
const id = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
const sourcesArb: fc.Arbitrary<CandidateSources> = fc.record({
  mutuals: fc.uniqueArray(
    fc.record({
      id,
      mutualCount: fc.integer({ min: 1, max: 50 }),
      sampleMutuals: fc.array(fc.string(), { maxLength: 3 }),
    }),
    { selector: (m) => m.id },
  ),
  interests: fc.uniqueArray(
    fc.record({
      id,
      sharedInterests: fc.integer({ min: 1, max: 50 }),
      sampleInterests: fc.array(fc.string(), { maxLength: 3 }),
    }),
    { selector: (m) => m.id },
  ),
  followsYou: fc.uniqueArray(fc.record({ id }), { selector: (m) => m.id }),
});
const weightsArb: fc.Arbitrary<Weights> = fc.record({
  mutual: fc.integer({ min: 0, max: 10 }),
  interest: fc.integer({ min: 0, max: 10 }),
  followsYou: fc.integer({ min: 0, max: 10 }),
});

describe('scoreCandidates properties', () => {
  it('input order never changes the output', () => {
    fc.assert(
      fc.property(sourcesArb, weightsArb, (sources, w) => {
        const reversed: CandidateSources = {
          mutuals: [...sources.mutuals].reverse(),
          interests: [...sources.interests].reverse(),
          followsYou: [...sources.followsYou].reverse(),
        };
        expect(scoreCandidates(reversed, w)).toEqual(scoreCandidates(sources, w));
      }),
    );
  });

  it('returns each candidate id exactly once, covering every source', () => {
    fc.assert(
      fc.property(sourcesArb, weightsArb, (sources, w) => {
        const ids = scoreCandidates(sources, w).map((c) => c.id);
        const expected = new Set([
          ...sources.mutuals.map((m) => m.id),
          ...sources.interests.map((m) => m.id),
          ...sources.followsYou.map((m) => m.id),
        ]);
        expect(ids).toHaveLength(expected.size);
        expect(new Set(ids)).toEqual(expected);
      }),
    );
  });

  it('is sorted by score descending, then id ascending', () => {
    fc.assert(
      fc.property(sourcesArb, weightsArb, (sources, w) => {
        const scored = scoreCandidates(sources, w);
        for (let i = 1; i < scored.length; i++) {
          const prev = scored[i - 1];
          const cur = scored[i];
          if (prev === undefined || cur === undefined) continue;
          expect(prev.score > cur.score || (prev.score === cur.score && prev.id < cur.id)).toBe(
            true,
          );
        }
      }),
    );
  });

  it('adding a follows-you signal never lowers any candidate score', () => {
    fc.assert(
      fc.property(sourcesArb, weightsArb, id, (sources, w, extra) => {
        const before = new Map(scoreCandidates(sources, w).map((c) => [c.id, c.score]));
        const more: CandidateSources = {
          ...sources,
          followsYou: sources.followsYou.some((f) => f.id === extra)
            ? sources.followsYou
            : [...sources.followsYou, { id: extra }],
        };
        for (const c of scoreCandidates(more, w)) {
          expect(c.score).toBeGreaterThanOrEqual(before.get(c.id) ?? 0);
        }
      }),
    );
  });
});
