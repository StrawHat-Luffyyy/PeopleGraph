import { describe, expect, it, vi } from 'vitest';
import { recommend, type RecoPorts } from '../../src/reco/pipeline.js';
import type { CandidateSources, Weights } from '../../src/reco/types.js';
import { NotFoundError } from '../../src/shared/errors.js';

const weights: Weights = { mutual: 3, interest: 2, followsYou: 5 };

function ports(sources: CandidateSources | null, opts: { deny?: string[]; gone?: string[] } = {}) {
  const calls: string[] = [];
  const p = {
    generate: vi.fn<RecoPorts['generate']>(() => {
      calls.push('generate');
      return Promise.resolve(sources);
    }),
    filter: vi.fn<RecoPorts['filter']>((_userId, ids) => {
      calls.push('filter');
      return Promise.resolve(new Set(ids.filter((id) => !(opts.deny ?? []).includes(id))));
    }),
    hydrate: vi.fn<RecoPorts['hydrate']>((ids) => {
      calls.push('hydrate');
      const live = ids.filter((id) => !(opts.gone ?? []).includes(id));
      return Promise.resolve(
        new Map(live.map((id) => [id, { handle: `h_${id}`, followerCount: id.length }])),
      );
    }),
  };
  return { p, calls };
}

/** Candidates c00..c(n-1) with strictly descending mutual counts, so rank = index. */
function ranked(n: number): CandidateSources {
  return {
    mutuals: Array.from({ length: n }, (_, i) => ({
      id: `c${String(i).padStart(2, '0')}`,
      mutualCount: n - i,
      sampleMutuals: ['ana'],
    })),
    interests: [],
    followsYou: [],
  };
}

describe('recommend', () => {
  it('runs generate, then filter, then hydrate, in that order', async () => {
    const { p, calls } = ports(ranked(3));
    await recommend('me', 10, p, weights);
    expect(calls).toEqual(['generate', 'filter', 'hydrate']);
    expect(p.generate).toHaveBeenCalledWith('me');
  });

  it('throws NotFoundError when the generators report an unknown user', async () => {
    const { p } = ports(null);
    await expect(recommend('ghost', 10, p, weights)).rejects.toBeInstanceOf(NotFoundError);
    expect(p.filter).not.toHaveBeenCalled();
  });

  it('returns an empty list (and skips filter/hydrate) when there are no candidates', async () => {
    const { p } = ports({ mutuals: [], interests: [], followsYou: [] });
    expect(await recommend('me', 10, p, weights)).toEqual([]);
    expect(p.filter).not.toHaveBeenCalled();
    expect(p.hydrate).not.toHaveBeenCalled();
  });

  it('over-fetches: sends the top 2 x limit candidates to the filter, in score order', async () => {
    const { p } = ports(ranked(30));
    await recommend('me', 5, p, weights);
    expect(p.filter).toHaveBeenCalledWith('me', [
      'c00',
      'c01',
      'c02',
      'c03',
      'c04',
      'c05',
      'c06',
      'c07',
      'c08',
      'c09',
    ]);
  });

  it('backfills from the over-fetch when the filter removes candidates', async () => {
    const { p } = ports(ranked(30), { deny: ['c00', 'c02'] });
    const result = await recommend('me', 5, p, weights);
    expect(result.map((r) => r.id)).toEqual(['c01', 'c03', 'c04', 'c05', 'c06']);
    expect(p.hydrate).toHaveBeenCalledWith(['c01', 'c03', 'c04', 'c05', 'c06']);
  });

  it('may return fewer than limit when the filter removes more than the buffer', async () => {
    const { p } = ports(ranked(4), { deny: ['c00', 'c01', 'c02'] });
    expect((await recommend('me', 3, p, weights)).map((r) => r.id)).toEqual(['c03']);
  });

  it('drops candidates that disappear before hydration, keeping score order', async () => {
    const { p } = ports(ranked(5), { gone: ['c01'] });
    const result = await recommend('me', 3, p, weights);
    expect(result.map((r) => r.id)).toEqual(['c00', 'c02']);
  });

  it('returns hydrated fields and explanations, never the internal score', async () => {
    const { p } = ports({
      mutuals: [{ id: 'c1', mutualCount: 2, sampleMutuals: ['ana', 'raj'] }],
      interests: [],
      followsYou: [{ id: 'c1' }],
    });
    const [rec] = await recommend('me', 10, p, weights);
    expect(rec).toEqual({
      id: 'c1',
      handle: 'h_c1',
      followerCount: 2,
      reasons: [{ type: 'mutuals', count: 2, sample: ['ana', 'raj'] }, { type: 'follows_you' }],
      explanation: 'followed by ana and raj; follows you',
    });
  });
});
