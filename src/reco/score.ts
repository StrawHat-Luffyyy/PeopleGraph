import type { CandidateSources, ScoredCandidate, Weights } from './types.js';

/**
 * Blends the candidate generators' output into one ranked list. Pure: no I/O, no clock,
 * no randomness, input untouched (invariant 6).
 *
 *   score = mutual * mutualCount + interest * sharedInterests + followsYou * (followsYou ? 1 : 0)
 *
 * Sorted by score descending, then id ascending, so equal scores rank deterministically.
 */
export function scoreCandidates(sources: CandidateSources, weights: Weights): ScoredCandidate[] {
  const merged = new Map<string, ScoredCandidate>();
  const entry = (id: string): ScoredCandidate => {
    let c = merged.get(id);
    if (c === undefined) {
      c = {
        id,
        score: 0,
        mutualCount: 0,
        sampleMutuals: [],
        sharedInterests: 0,
        sampleInterests: [],
        followsYou: false,
      };
      merged.set(id, c);
    }
    return c;
  };

  for (const m of sources.mutuals) {
    const c = entry(m.id);
    c.mutualCount = m.mutualCount;
    c.sampleMutuals = [...m.sampleMutuals];
  }
  for (const i of sources.interests) {
    const c = entry(i.id);
    c.sharedInterests = i.sharedInterests;
    c.sampleInterests = [...i.sampleInterests];
  }
  for (const f of sources.followsYou) {
    entry(f.id).followsYou = true;
  }

  const scored = [...merged.values()].map((c) => ({
    ...c,
    score:
      weights.mutual * c.mutualCount +
      weights.interest * c.sharedInterests +
      weights.followsYou * (c.followsYou ? 1 : 0),
  }));
  return scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
