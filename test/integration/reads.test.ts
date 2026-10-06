import { describe, expect, it } from 'vitest';
import type { SinceCursor } from '../../src/api/pagination.js';
import { ReadRepository, type FollowPage } from '../../src/graph/readRepository.js';
import { NotFoundError, ValidationError } from '../../src/shared/errors.js';
import { createUsers, timeouts, useGraph } from './support/graph.js';

describe('ReadRepository', () => {
  const g = useGraph();
  const reads = () => new ReadRepository(g.driver, timeouts);

  /** Follows target from each id in parallel batches (real follow path, real timestamps). */
  async function followAll(followerIds: string[], targetId: string): Promise<void> {
    for (let i = 0; i < followerIds.length; i += 25) {
      await Promise.all(followerIds.slice(i, i + 25).map((id) => g.social.follow(id, targetId)));
    }
  }

  /** Walks every page, calling `between` after each page; returns ids in walk order. */
  async function walk(
    fetch: (cursor: SinceCursor | null) => Promise<FollowPage>,
    between: (pageIndex: number, seenSoFar: readonly string[]) => Promise<void> = () =>
      Promise.resolve(),
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: SinceCursor | null = null;
    for (let page = 0; page < 1000; page++) {
      const result = await fetch(cursor);
      seen.push(...result.items.map((item) => item.id));
      if (result.next === null) return seen;
      cursor = result.next;
      await between(page, seen);
    }
    throw new Error('pagination did not terminate');
  }

  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);

  describe('followers', () => {
    it('lists newest first with since and handle', async () => {
      await createUsers(g.users, 'star', 'f1', 'f2', 'f3');
      for (const f of ['f1', 'f2', 'f3']) {
        await g.social.follow(f, 'star');
        await new Promise((r) => setTimeout(r, 5)); // distinct milliseconds
      }
      const page = await reads().followers('star', { limit: 10, cursor: null });
      expect(page.items.map((i) => i.id)).toEqual(['f3', 'f2', 'f1']);
      expect(page.items[0]).toMatchObject({ handle: 'h_f3' });
      expect(page.items[0]?.since).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(page.next).toBeNull();
    });

    it('returns an empty page for a user with no followers', async () => {
      await createUsers(g.users, 'lonely');
      expect(await reads().followers('lonely', { limit: 10, cursor: null })).toEqual({
        items: [],
        next: null,
      });
    });

    it('has no next cursor when the limit exactly matches the total', async () => {
      const fans = ids('fan', 5);
      await createUsers(g.users, 'star', ...fans);
      await followAll(fans, 'star');
      const page = await reads().followers('star', { limit: 5, cursor: null });
      expect(page.items).toHaveLength(5);
      expect(page.next).toBeNull();
    });

    it('throws NotFoundError for an unknown user', async () => {
      await expect(reads().followers('ghost', { limit: 10, cursor: null })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('REQUIRED: no duplicates or gaps while new follows arrive between pages', async () => {
      const original = ids('orig', 250);
      await createUsers(g.users, 'star', 'x', 'y', ...original);
      await followAll(original, 'star');

      const late = ids('late', 40);
      await createUsers(g.users, ...late);
      let nextLate = 0;

      const seen = await walk(
        (cursor) => reads().followers('star', { limit: 37, cursor }),
        async () => {
          // New followers of star arrive concurrently, plus unrelated follows elsewhere.
          const batch = late.slice(nextLate, nextLate + 5);
          nextLate += 5;
          await Promise.all([
            ...batch.map((id) => g.social.follow(id, 'star')),
            g.social.follow('x', 'y'),
            g.social.unfollow('x', 'y'),
          ]);
        },
      );

      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect([...seen].sort()).toEqual([...original].sort()); // no gaps, nothing new mid-walk
      expect(nextLate).toBeGreaterThan(0);
    });

    it('no gaps when already-seen followers unfollow mid-walk (where SKIP would skip)', async () => {
      const original = ids('orig', 120);
      await createUsers(g.users, 'star', ...original);
      await followAll(original, 'star');

      const seen = await walk(
        (cursor) => reads().followers('star', { limit: 20, cursor }),
        async (page, seenSoFar) => {
          // Remove three followers we have already returned on this page.
          const alreadySeen = seenSoFar.slice(page * 20, page * 20 + 3);
          await Promise.all(alreadySeen.map((id) => g.social.unfollow(id, 'star')));
        },
      );
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...original].sort());
    });

    it('pages through 120 bulk-loaded edges that share one identical since', async () => {
      const fans = ids('bulk', 120);
      await createUsers(g.users, 'star', ...fans);
      // Same shape the bulk loader writes: one timestamp for the whole batch.
      await g.driver.executeQuery(
        `MATCH (s:User {id: 'star'})
         UNWIND $fans AS fanId
         MATCH (f:User {id: fanId})
         CREATE (f)-[:FOLLOWS {since: datetime('2026-01-01T00:00:00.000000001Z')}]->(s)
         SET f.followingCount = f.followingCount + 1, s.followerCount = s.followerCount + 1`,
        { fans },
      );
      const seen = await walk((cursor) => reads().followers('star', { limit: 25, cursor }));
      expect(seen).toEqual([...fans].sort().reverse()); // tie broken by id DESC
    });

    it('orders by since then id across tie groups that straddle page boundaries', async () => {
      // Three timestamps x 30 edges, paged by 25: boundaries land inside each group, so a
      // wrong since/id predicate shows up as a skipped or repeated row.
      const groups = [
        { since: '2026-01-03T00:00:00Z', fans: ids('g3_', 30) },
        { since: '2026-01-02T00:00:00.000000500Z', fans: ids('g2_', 30) },
        { since: '2026-01-02T00:00:00.000000499Z', fans: ids('g1_', 30) }, // 1 ns apart
      ];
      await createUsers(g.users, 'star', ...groups.flatMap((grp) => grp.fans));
      for (const grp of groups) {
        await g.driver.executeQuery(
          `MATCH (s:User {id: 'star'})
           UNWIND $fans AS fanId
           MATCH (f:User {id: fanId})
           CREATE (f)-[:FOLLOWS {since: datetime($since)}]->(s)
           SET f.followingCount = f.followingCount + 1, s.followerCount = s.followerCount + 1`,
          { fans: grp.fans, since: grp.since },
        );
      }
      const seen = await walk((cursor) => reads().followers('star', { limit: 25, cursor }));
      const expected = groups.flatMap((grp) => [...grp.fans].sort().reverse());
      expect(seen).toEqual(expected);
    });
  });

  describe('following', () => {
    it('mirrors followers: everyone the user follows, newest first, paged', async () => {
      const targets = ids('t', 45);
      await createUsers(g.users, 'me', ...targets);
      for (let i = 0; i < targets.length; i += 15) {
        await Promise.all(targets.slice(i, i + 15).map((t) => g.social.follow('me', t)));
      }
      const seen = await walk((cursor) => reads().following('me', { limit: 10, cursor }));
      expect(new Set(seen).size).toBe(45);
      expect([...seen].sort()).toEqual([...targets].sort());
    });

    it('throws NotFoundError for an unknown user', async () => {
      await expect(reads().following('ghost', { limit: 10, cursor: null })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('mutuals', () => {
    async function mutualSetup() {
      const shared = ids('m', 30);
      const onlyA = ids('oa', 50); // a follows many more accounts than b
      await createUsers(g.users, 'a', 'b', ...shared, ...onlyA, 'ob');
      for (const m of [...shared, ...onlyA]) await g.social.follow('a', m);
      for (const m of [...shared, 'ob']) await g.social.follow('b', m);
      return shared;
    }

    async function walkMutuals(a: string, b: string, limit: number): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const result = await reads().mutuals(a, b, { limit, cursor });
        seen.push(...result.items.map((i) => i.id));
        if (result.next === null) return seen;
        cursor = result.next;
      }
      throw new Error('pagination did not terminate');
    }

    it('returns exactly the accounts both users follow, ordered by id, across pages', async () => {
      const shared = await mutualSetup();
      expect(await walkMutuals('a', 'b', 12)).toEqual(shared); // 3 pages: 12, 12, 6
    });

    it('gives the same answer whichever side follows fewer', async () => {
      const shared = await mutualSetup();
      expect(await walkMutuals('b', 'a', 12)).toEqual(shared);
    });

    it('returns handles', async () => {
      await mutualSetup();
      const page = await reads().mutuals('a', 'b', { limit: 1, cursor: null });
      expect(page.items).toEqual([{ id: 'm0000', handle: 'h_m0000' }]);
    });

    it('is empty when nothing is shared, and never includes the two users', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.follow('a', 'b');
      await g.social.follow('b', 'a');
      expect(await reads().mutuals('a', 'b', { limit: 10, cursor: null })).toEqual({
        items: [],
        next: null,
      });
    });

    it('throws NotFoundError when either user is unknown', async () => {
      await createUsers(g.users, 'a');
      await expect(
        reads().mutuals('a', 'ghost', { limit: 10, cursor: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        reads().mutuals('ghost', 'a', { limit: 10, cursor: null }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects mutuals of a user with themselves', async () => {
      await createUsers(g.users, 'a');
      await expect(reads().mutuals('a', 'a', { limit: 10, cursor: null })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });
});
