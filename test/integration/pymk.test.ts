import { describe, expect, it } from 'vitest';
import { RecoRepository, type RecoBounds } from '../../src/graph/recoRepository.js';
import { recommend } from '../../src/reco/pipeline.js';
import type { Weights } from '../../src/reco/types.js';
import { NotFoundError } from '../../src/shared/errors.js';
import { createUsers, timeouts, useGraph } from './support/graph.js';

const weights: Weights = { mutual: 3, interest: 2, followsYou: 5 };
const defaults: RecoBounds = {
  maxFriends: 200,
  maxFanout: 1000,
  maxInterestFanout: 5000,
  maxFollowersScan: 5000,
  candidatesPerSource: 100,
};
const pause = () => new Promise((r) => setTimeout(r, 5)); // distinct `since` milliseconds

describe('PYMK', () => {
  const g = useGraph();
  const repo = (bounds: Partial<RecoBounds> = {}) =>
    new RecoRepository(g.driver, timeouts, { ...defaults, ...bounds });

  /**
   * me follows f1, f2, f3 (and x). Expected, with weights 3/2/5:
   *   c1  followed by f1, f2, f3        -> 9
   *   c4  follows me                    -> 5
   *   c3  shares rust and chess with me -> 4
   *   c2  followed by f1                -> 3
   * Must never appear: me (f1 follows me), x (already followed), blockedme (blocked me),
   * iblocked (I blocked them).
   */
  async function buildGraph(): Promise<void> {
    await createUsers(g.users, 'me', 'f1', 'f2', 'f3', 'x', 'c1', 'c2', 'c3', 'c4');
    await createUsers(g.users, 'blockedme', 'iblocked');
    for (const f of ['f1', 'f2', 'f3', 'x']) await g.social.follow('me', f);
    for (const f of ['f1', 'f2', 'f3']) await g.social.follow(f, 'c1');
    await g.social.follow('f1', 'c2');
    await g.social.follow('f1', 'x'); // already followed: excluded
    await g.social.follow('f1', 'me'); // self via friends-of-friends: excluded
    await g.social.follow('c4', 'me');
    await g.social.follow('f2', 'iblocked');
    await g.social.follow('f3', 'blockedme');
    await g.social.block('me', 'iblocked');
    await g.social.block('blockedme', 'me');
    await g.users.replaceInterests('me', ['rust', 'chess', 'go']);
    await g.users.replaceInterests('c3', ['rust', 'chess']);
    await g.users.replaceInterests('blockedme', ['rust', 'chess', 'go']); // excluded anyway
    await g.users.replaceInterests('iblocked', ['rust']); // excluded anyway
  }

  it('ranks candidates by blended score with explanations', async () => {
    await buildGraph();
    const recs = await recommend('me', 10, repo(), weights);
    expect(recs.map((r) => [r.id, r.explanation])).toEqual([
      ['c1', 'followed by h_f1, h_f2 and h_f3'],
      ['c4', 'follows you'],
      ['c3', 'shares interests: chess, rust'],
      ['c2', 'followed by h_f1'],
    ]);
    expect(recs[0]).toMatchObject({ handle: 'h_c1', followerCount: 3 });
  });

  it('REQUIRED: excludes self, already-followed, and blocked users (both directions)', async () => {
    await buildGraph();
    const ids = (await recommend('me', 50, repo(), weights)).map((r) => r.id);
    for (const excluded of ['me', 'f1', 'f2', 'f3', 'x', 'blockedme', 'iblocked']) {
      expect(ids).not.toContain(excluded);
    }
  });

  it('the filter stage alone removes self, followed, blocked and unknown ids', async () => {
    await buildGraph();
    const allowed = await repo().filter('me', [
      'me',
      'x',
      'f1',
      'iblocked',
      'blockedme',
      'ghost',
      'c1',
      'c3',
    ]);
    expect([...allowed].sort()).toEqual(['c1', 'c3']);
  });

  it('respects the limit', async () => {
    await buildGraph();
    expect((await recommend('me', 2, repo(), weights)).map((r) => r.id)).toEqual(['c1', 'c4']);
  });

  it('returns an empty list for a user with no signals', async () => {
    await createUsers(g.users, 'loner');
    expect(await recommend('loner', 10, repo(), weights)).toEqual([]);
  });

  it('throws NotFoundError for an unknown user', async () => {
    await expect(recommend('ghost', 10, repo(), weights)).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('bounds take effect', () => {
    it('fan-out cap: a friend who follows too many accounts contributes nothing', async () => {
      await createUsers(g.users, 'me', 'big', 'a1', 'a2', 'target');
      await g.social.follow('me', 'big');
      for (const t of ['a1', 'a2', 'target']) await g.social.follow('big', t); // big follows 3
      const ids = async (maxFanout: number) =>
        (await repo({ maxFanout }).generate('me'))?.mutuals.map((m) => m.id) ?? [];
      expect(await ids(2)).toEqual([]);
      expect(await ids(3)).toEqual(['a1', 'a2', 'target']);
    });

    it('interest cap: an over-popular interest contributes nothing', async () => {
      await createUsers(g.users, 'me', 'p1', 'p2');
      for (const u of ['me', 'p1', 'p2']) await g.users.replaceInterests(u, ['popular']);
      const ids = async (maxInterestFanout: number) =>
        (await repo({ maxInterestFanout }).generate('me'))?.interests.map((m) => m.id) ?? [];
      expect(await ids(2)).toEqual([]); // 3 members > 2
      expect(await ids(3)).toEqual(['p1', 'p2']);
    });

    it('first-hop cap: only my most recent follows are expanded', async () => {
      await createUsers(g.users, 'me', 'old', 'mid', 'new', 'viaold', 'vianew');
      for (const f of ['old', 'mid', 'new']) {
        await g.social.follow('me', f);
        await pause();
      }
      await g.social.follow('old', 'viaold');
      await g.social.follow('new', 'vianew');
      const ids = async (maxFriends: number) =>
        (await repo({ maxFriends }).generate('me'))?.mutuals.map((m) => m.id).sort() ?? [];
      expect(await ids(2)).toEqual(['vianew']);
      expect(await ids(3)).toEqual(['vianew', 'viaold']);
    });

    it('followers-scan cap: follows-you is skipped for users with many followers', async () => {
      await createUsers(g.users, 'me', 'fan1', 'fan2');
      await g.social.follow('fan1', 'me');
      await g.social.follow('fan2', 'me');
      const ids = async (maxFollowersScan: number) =>
        (await repo({ maxFollowersScan }).generate('me'))?.followsYou.map((m) => m.id).sort() ?? [];
      expect(await ids(1)).toEqual([]);
      expect(await ids(2)).toEqual(['fan1', 'fan2']);
    });

    it('candidatesPerSource caps each generator', async () => {
      await createUsers(g.users, 'me', 'f', 't1', 't2', 't3');
      await g.social.follow('me', 'f');
      for (const t of ['t1', 't2', 't3']) await g.social.follow('f', t);
      const sources = await repo({ candidatesPerSource: 2 }).generate('me');
      expect(sources?.mutuals.map((m) => m.id)).toEqual(['t1', 't2']); // tie broken by id
    });
  });
});
