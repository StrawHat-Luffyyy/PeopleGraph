import { NotFoundError } from '../shared/errors.js';
import { explain } from './explain.js';
import { scoreCandidates } from './score.js';
import type { CandidateSources, Recommendation, Weights } from './types.js';

export interface HydratedUser {
  handle: string;
  followerCount: number;
}

/**
 * The I/O stages of the pipeline. Implemented with Cypher in src/graph/recoRepository.ts;
 * faked in unit tests.
 */
export interface RecoPorts {
  /** Runs the candidate generators. null means the user does not exist. */
  generate(userId: string): Promise<CandidateSources | null>;
  /**
   * Returns the subset of ids that may be recommended right now: not the user, not
   * already followed, no block either way, still exists. This is the exclusion
   * guarantee; generator-side exclusions are only an optimization.
   */
  filter(userId: string, ids: readonly string[]): Promise<Set<string>>;
  hydrate(ids: readonly string[]): Promise<Map<string, HydratedUser>>;
}

/** Candidates sent to the filter per requested result, so exclusions can be backfilled. */
export const OVERFETCH_FACTOR = 2;

/**
 * People-you-may-know, staged per invariant 6: generate (Cypher) -> score (pure) ->
 * filter (Cypher) -> hydrate (Cypher) -> explain (pure). Can return fewer than `limit`
 * if the filter removes more candidates than the over-fetch covers.
 */
export async function recommend(
  userId: string,
  limit: number,
  ports: RecoPorts,
  weights: Weights,
): Promise<Recommendation[]> {
  const sources = await ports.generate(userId);
  if (sources === null) throw new NotFoundError('user not found');

  const scored = scoreCandidates(sources, weights);
  if (scored.length === 0) return [];

  const shortlist = scored.slice(0, limit * OVERFETCH_FACTOR);
  const allowed = await ports.filter(
    userId,
    shortlist.map((c) => c.id),
  );
  const kept = shortlist.filter((c) => allowed.has(c.id)).slice(0, limit);
  if (kept.length === 0) return [];

  const users = await ports.hydrate(kept.map((c) => c.id));
  return kept.flatMap((c) => {
    const user = users.get(c.id);
    if (user === undefined) return [];
    return [{ id: c.id, handle: user.handle, followerCount: user.followerCount, ...explain(c) }];
  });
}
