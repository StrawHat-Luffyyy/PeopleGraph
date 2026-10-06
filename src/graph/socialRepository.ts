import neo4j, { type Driver } from 'neo4j-driver';
import { ForbiddenError, NotFoundError, ValidationError } from '../shared/errors.js';
import { toNumber } from './convert.js';
import { loadCypher } from './cypher.js';
import { lockUsers } from './locks.js';
import { runRead, runWrite } from './tx.js';
import type { Timeouts } from './userRepository.js';

export interface CounterDrift {
  id: string;
  storedFollowers: number | null;
  actualFollowers: number;
  storedFollowing: number | null;
  actualFollowing: number;
}

/**
 * Follow, unfollow and block. Each runs in one write transaction that first locks both
 * users (sorted order), then reads and changes the edges between them, so concurrent
 * writes on the same pair serialize. See docs/adr/0001.
 */
export class SocialRepository {
  constructor(
    private readonly driver: Driver,
    private readonly timeouts: Timeouts,
  ) {}

  async follow(followerId: string, targetId: string): Promise<{ created: boolean }> {
    if (followerId === targetId) throw new ValidationError('cannot follow yourself');
    return runWrite(this.driver, this.timeouts.writeTimeoutMs, async (tx) => {
      const found = await lockUsers(tx, [followerId, targetId]);
      if (!found.has(followerId) || !found.has(targetId)) {
        throw new NotFoundError('user not found');
      }
      const result = await tx.run(loadCypher('follow'), { followerId, targetId });
      const row = result.records[0];
      // Both users exist and are distinct, so zero rows can only mean a block.
      if (row === undefined) throw new ForbiddenError('cannot follow this user');
      return { created: row.get('created') as boolean };
    });
  }

  /** Idempotent: unknown users or a missing edge return removed=false, not an error. */
  async unfollow(followerId: string, targetId: string): Promise<{ removed: boolean }> {
    if (followerId === targetId) return { removed: false };
    return runWrite(this.driver, this.timeouts.writeTimeoutMs, async (tx) => {
      await lockUsers(tx, [followerId, targetId]);
      const result = await tx.run(loadCypher('unfollow'), { followerId, targetId });
      return { removed: result.records.length > 0 };
    });
  }

  async block(blockerId: string, targetId: string): Promise<{ created: boolean }> {
    if (blockerId === targetId) throw new ValidationError('cannot block yourself');
    return runWrite(this.driver, this.timeouts.writeTimeoutMs, async (tx) => {
      const found = await lockUsers(tx, [blockerId, targetId]);
      if (!found.has(blockerId) || !found.has(targetId)) {
        throw new NotFoundError('user not found');
      }
      const result = await tx.run(loadCypher('block'), { blockerId, targetId });
      const row = result.records[0];
      if (row === undefined) throw new Error('block returned no row');
      return { created: row.get('created') as boolean };
    });
  }

  /** Users whose stored counters disagree with real degrees. Empty means healthy. */
  async findCounterDrift(limit = 100): Promise<CounterDrift[]> {
    return runRead(this.driver, this.timeouts.readTimeoutMs, async (tx) => {
      // LIMIT needs an integer; a plain JS number is sent as a float.
      const result = await tx.run(loadCypher('counter-drift'), { limit: neo4j.int(limit) });
      return result.records.map((r) => ({
        id: r.get('id') as string,
        storedFollowers: nullableNumber(r.get('storedFollowers')),
        actualFollowers: toNumber(r.get('actualFollowers')),
        storedFollowing: nullableNumber(r.get('storedFollowing')),
        actualFollowing: toNumber(r.get('actualFollowing')),
      }));
    });
  }
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : toNumber(value);
}
