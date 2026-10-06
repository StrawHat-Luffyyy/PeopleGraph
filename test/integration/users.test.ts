import { describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../src/shared/errors.js';
import { interestsOf, nodeCount, useGraph } from './support/graph.js';

describe('UserRepository', () => {
  const g = useGraph();

  describe('createUser', () => {
    it('creates a user with zeroed counters', async () => {
      const result = await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      expect(result).toEqual({
        created: true,
        user: { id: 'u1', handle: 'ana', followerCount: 0, followingCount: 0 },
      });
    });

    it('is idempotent for the same id and handle', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      const again = await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      expect(again.created).toBe(false);
      expect(await nodeCount(g.driver, 'User')).toBe(1);
    });

    it('rejects a handle already used by another id with ConflictError', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      await expect(
        g.users.createUser({ id: 'u2', handle: 'ana', name: 'Other' }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rejects reusing an id with a different handle with ConflictError', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      await expect(
        g.users.createUser({ id: 'u1', handle: 'ana2', name: 'Ana' }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('creates exactly one node under 50 concurrent identical requests', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' }),
        ),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await nodeCount(g.driver, 'User')).toBe(1);
    });
  });

  describe('replaceInterests', () => {
    it('stores the given interests', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      expect(await g.users.replaceInterests('u1', ['rust', 'chess'])).toEqual(['chess', 'rust']);
      expect(await interestsOf(g.driver, 'u1')).toEqual(['chess', 'rust']);
    });

    it('replaces rather than appends', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      await g.users.replaceInterests('u1', ['rust', 'chess']);
      await g.users.replaceInterests('u1', ['go']);
      expect(await interestsOf(g.driver, 'u1')).toEqual(['go']);
    });

    it('clears interests with an empty list', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      await g.users.replaceInterests('u1', ['rust']);
      expect(await g.users.replaceInterests('u1', [])).toEqual([]);
      expect(await interestsOf(g.driver, 'u1')).toEqual([]);
    });

    it('shares Interest nodes between users', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      await g.users.createUser({ id: 'u2', handle: 'raj', name: 'Raj' });
      await g.users.replaceInterests('u1', ['rust']);
      await g.users.replaceInterests('u2', ['rust']);
      expect(await nodeCount(g.driver, 'Interest')).toBe(1);
    });

    it('throws NotFoundError for an unknown user', async () => {
      await expect(g.users.replaceInterests('ghost', ['rust'])).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('never mixes two concurrent replacements', async () => {
      await g.users.createUser({ id: 'u1', handle: 'ana', name: 'Ana' });
      const setA = ['a1', 'a2', 'a3', 'a4', 'a5'];
      const setB = ['b1', 'b2', 'b3', 'b4', 'b5'];
      for (let round = 0; round < 10; round++) {
        await Promise.all([
          g.users.replaceInterests('u1', setA),
          g.users.replaceInterests('u1', setB),
        ]);
        const stored = await interestsOf(g.driver, 'u1');
        expect([setA, setB]).toContainEqual(stored);
      }
    });
  });
});
