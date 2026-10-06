import type { Reason, ScoredCandidate } from './types.js';

/** "a", "a and b", "a, b and c". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * "followed by ana, raj and 5 others". Lists everyone when there are at most 3 and all
 * were sampled; otherwise two names and a count, so the text stays short.
 */
function mutualsText(count: number, sample: readonly string[]): string {
  if (sample.length === 0) {
    return `followed by ${count} ${count === 1 ? 'person' : 'people'} you follow`;
  }
  if (count <= 3 && sample.length >= count)
    return `followed by ${joinNames(sample.slice(0, count))}`;
  const named = sample.slice(0, 2);
  const others = count - named.length;
  return `followed by ${named.join(', ')} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

/** "shares an interest: rust", "shares interests: chess, go, rust and 2 more". */
function interestsText(count: number, sample: readonly string[]): string {
  if (count === 1 && sample.length === 1) return `shares an interest: ${sample[0] ?? ''}`;
  const more = count - sample.length;
  return `shares interests: ${sample.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * Builds the human-readable reason for a recommendation from the signals that produced
 * it. Pure. Reasons appear in a fixed order: mutuals, interests, follows you.
 */
export function explain(candidate: ScoredCandidate): { reasons: Reason[]; explanation: string } {
  const reasons: Reason[] = [];
  const parts: string[] = [];

  if (candidate.mutualCount > 0) {
    reasons.push({
      type: 'mutuals',
      count: candidate.mutualCount,
      sample: [...candidate.sampleMutuals],
    });
    parts.push(mutualsText(candidate.mutualCount, candidate.sampleMutuals));
  }
  if (candidate.sharedInterests > 0) {
    reasons.push({
      type: 'interests',
      count: candidate.sharedInterests,
      sample: [...candidate.sampleInterests],
    });
    parts.push(interestsText(candidate.sharedInterests, candidate.sampleInterests));
  }
  if (candidate.followsYou) {
    reasons.push({ type: 'follows_you' });
    parts.push('follows you');
  }

  return { reasons, explanation: parts.join('; ') };
}
