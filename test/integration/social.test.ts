import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/shared/errors.js';
import { counters, createUsers, edgeCount, useGraph } from './support/graph.js';

describe('SocialRepository', () => {
  const g = useGraph();

  describe('follow', () => {
    it('creates one edge and bumps both counters', async () => {
      await createUsers(g.users, 'a', 'b');
      expect(await g.social.follow('a', 'b')).toEqual({ created: true });
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(1);
      expect(await counters(g.driver, 'a')).toEqual({ followers: 0, following: 1 });
      expect(await counters(g.driver, 'b')).toEqual({ followers: 1, following: 0 });
    });

    it('is idempotent: a repeat follow changes nothing', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.follow('a', 'b');
      expect(await g.social.follow('a', 'b')).toEqual({ created: false });
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(1);
      expect(await counters(g.driver, 'b')).toEqual({ followers: 1, following: 0 });
    });

    it('rejects a self-follow with ValidationError', async () => {
      await createUsers(g.users, 'a');
      await expect(g.social.follow('a', 'a')).rejects.toBeInstanceOf(ValidationError);
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'a')).toBe(0);
    });

    it('throws NotFoundError when either user is missing', async () => {
      await createUsers(g.users, 'a');
      await expect(g.social.follow('a', 'ghost')).rejects.toBeInstanceOf(NotFoundError);
      await expect(g.social.follow('ghost', 'a')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws ForbiddenError when the follower blocked the target', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.block('a', 'b');
      await expect(g.social.follow('a', 'b')).rejects.toBeInstanceOf(ForbiddenError);
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(0);
    });

    it('throws ForbiddenError when the target blocked the follower', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.block('b', 'a');
      await expect(g.social.follow('a', 'b')).rejects.toBeInstanceOf(ForbiddenError);
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(0);
    });

    it('REQUIRED: 100 concurrent follows of one pair give one edge and a count of 1', async () => {
      await createUsers(g.users, 'a', 'b');
      const results = await Promise.all(
        Array.from({ length: 100 }, () => g.social.follow('a', 'b')),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(1);
      expect(await counters(g.driver, 'b')).toEqual({ followers: 1, following: 0 });
      expect(await counters(g.driver, 'a')).toEqual({ followers: 0, following: 1 });
    });

    it('50 A->B follows racing 50 B->A follows give both edges and correct counts', async () => {
      await createUsers(g.users, 'a', 'b');
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          i % 2 === 0 ? g.social.follow('a', 'b') : g.social.follow('b', 'a'),
        ),
      );
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(1);
      expect(await edgeCount(g.driver, 'FOLLOWS', 'b', 'a')).toBe(1);
      expect(await counters(g.driver, 'a')).toEqual({ followers: 1, following: 1 });
      expect(await counters(g.driver, 'b')).toEqual({ followers: 1, following: 1 });
    });

    it('many users following one account concurrently each count once', async () => {
      const fans = Array.from({ length: 40 }, (_, i) => `fan${i}`);
      await createUsers(g.users, 'star', ...fans);
      await Promise.all(fans.map((f) => g.social.follow(f, 'star')));
      expect(await counters(g.driver, 'star')).toEqual({ followers: 40, following: 0 });
    });
  });

  describe('unfollow', () => {
    it('removes the edge and decrements both counters', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.follow('a', 'b');
      expect(await g.social.unfollow('a', 'b')).toEqual({ removed: true });
      expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(0);
      expect(await counters(g.driver, 'a')).toEqual({ followers: 0, following: 0 });
      expect(await counters(g.driver, 'b')).toEqual({ followers: 0, following: 0 });
    });

    it('is idempotent: unfollowing when not following is a no-op', async () => {
      await createUsers(g.users, 'a', 'b');
      expect(await g.social.unfollow('a', 'b')).toEqual({ removed: false });
      expect(await counters(g.driver, 'b')).toEqual({ followers: 0, following: 0 });
    });

    it('is a no-op (not an error) for unknown users', async () => {
      await createUsers(g.users, 'a');
      expect(await g.social.unfollow('a', 'ghost')).toEqual({ removed: false });
    });

    it('100 concurrent unfollows remove one edge and decrement once', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.follow('a', 'b');
      const results = await Promise.all(
        Array.from({ length: 100 }, () => g.social.unfollow('a', 'b')),
      );
      expect(results.filter((r) => r.removed)).toHaveLength(1);
      expect(await counters(g.driver, 'a')).toEqual({ followers: 0, following: 0 });
      expect(await counters(g.driver, 'b')).toEqual({ followers: 0, following: 0 });
    });
  });

  describe('block', () => {
    it.each([
      { name: 'neither follows', aFollowsB: false, bFollowsA: false },
      { name: 'blocker follows target', aFollowsB: true, bFollowsA: false },
      { name: 'target follows blocker', aFollowsB: false, bFollowsA: true },
      { name: 'both follow each other', aFollowsB: true, bFollowsA: true },
    ])(
      'REQUIRED: removes follows both ways and fixes counters ($name)',
      async ({ aFollowsB, bFollowsA }) => {
        await createUsers(g.users, 'a', 'b', 'c');
        // c follows both, so we can check unrelated edges and counts survive.
        await g.social.follow('c', 'a');
        await g.social.follow('c', 'b');
        if (aFollowsB) await g.social.follow('a', 'b');
        if (bFollowsA) await g.social.follow('b', 'a');

        expect(await g.social.block('a', 'b')).toEqual({ created: true });

        expect(await edgeCount(g.driver, 'BLOCKED', 'a', 'b')).toBe(1);
        expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(0);
        expect(await edgeCount(g.driver, 'FOLLOWS', 'b', 'a')).toBe(0);
        expect(await counters(g.driver, 'a')).toEqual({ followers: 1, following: 0 });
        expect(await counters(g.driver, 'b')).toEqual({ followers: 1, following: 0 });
        expect(await counters(g.driver, 'c')).toEqual({ followers: 0, following: 2 });
      },
    );

    it('is idempotent', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.follow('b', 'a');
      await g.social.block('a', 'b');
      expect(await g.social.block('a', 'b')).toEqual({ created: false });
      expect(await edgeCount(g.driver, 'BLOCKED', 'a', 'b')).toBe(1);
      expect(await counters(g.driver, 'a')).toEqual({ followers: 0, following: 0 });
    });

    it('allows mutual blocks', async () => {
      await createUsers(g.users, 'a', 'b');
      await g.social.block('a', 'b');
      expect(await g.social.block('b', 'a')).toEqual({ created: true });
    });

    it('rejects a self-block with ValidationError', async () => {
      await createUsers(g.users, 'a');
      await expect(g.social.block('a', 'a')).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws NotFoundError for an unknown target', async () => {
      await createUsers(g.users, 'a');
      await expect(g.social.block('a', 'ghost')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a follow racing a block never leaves a FOLLOWS edge between blocked users', async () => {
      for (let round = 0; round < 20; round++) {
        await g.driver.executeQuery('MATCH (n) DETACH DELETE n');
        await createUsers(g.users, 'a', 'b');
        await Promise.allSettled([g.social.follow('b', 'a'), g.social.block('a', 'b')]);
        expect(await edgeCount(g.driver, 'BLOCKED', 'a', 'b')).toBe(1);
        expect(await edgeCount(g.driver, 'FOLLOWS', 'b', 'a')).toBe(0);
        expect(await edgeCount(g.driver, 'FOLLOWS', 'a', 'b')).toBe(0);
        expect(await counters(g.driver, 'a')).toEqual({ followers: 0, following: 0 });
      }
    });
  });
});
