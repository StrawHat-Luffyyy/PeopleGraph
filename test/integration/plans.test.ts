import neo4j, { type Plan } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { loadCypher } from '../../src/graph/cypher.js';
import { useGraph } from './support/graph.js';

function operators(plan: Plan): string[] {
  return [plan.operatorType, ...plan.children.flatMap(operators)].map((op) =>
    op.replace(/@.*$/, ''),
  );
}

/**
 * Plan regression tests. Pair queries must find the edge between two known users with
 * Expand(Into) after seeking both endpoints; an Expand(All) from one endpoint walks all
 * of a celebrity's edges (measured: 40,009 vs 11 db hits at 20k followers, see
 * docs/profiles/phase1-writes.md).
 */
describe('query plans', () => {
  const g = useGraph();

  const pairQueries: [string, Record<string, string>][] = [
    ['follow', { followerId: 'a', targetId: 'b' }],
    ['unfollow', { followerId: 'a', targetId: 'b' }],
    ['block', { blockerId: 'a', targetId: 'b' }],
  ];

  it.each(pairQueries)('%s seeks both users and never uses Expand(All)', async (name, params) => {
    const { summary } = await g.driver.executeQuery(`EXPLAIN ${loadCypher(name)}`, params);
    const ops = operators(summary.plan as Plan);
    expect(ops.filter((op) => op.startsWith('NodeUniqueIndexSeek'))).toHaveLength(2);
    expect(ops).not.toContain('Expand(All)');
    expect(ops).not.toContain('NodeByLabelScan');
    expect(ops).not.toContain('AllNodesScan');
  });

  it('lock-users only seeks by the unique id index', async () => {
    const { summary } = await g.driver.executeQuery(`EXPLAIN ${loadCypher('lock-users')}`, {
      ids: ['a', 'b'],
    });
    const ops = operators(summary.plan as Plan);
    expect(ops.some((op) => op.startsWith('NodeUniqueIndexSeek'))).toBe(true);
    expect(ops).not.toContain('NodeByLabelScan');
    expect(ops).not.toContain('AllNodesScan');
  });

  const listQueries: [string, Record<string, unknown>][] = [
    ['followers', { userId: 'a', cursorSince: null, cursorId: null, limit: neo4j.int(21) }],
    ['following', { userId: 'a', cursorSince: null, cursorId: null, limit: neo4j.int(21) }],
    ['mutuals', { aId: 'a', bId: 'b', cursorId: null, limit: neo4j.int(21) }],
  ];

  it.each(listQueries)(
    '%s starts from a unique index seek and never scans',
    async (name, params) => {
      const { summary } = await g.driver.executeQuery(`EXPLAIN ${loadCypher(name)}`, params);
      const ops = operators(summary.plan as Plan);
      expect(ops.some((op) => op.startsWith('NodeUniqueIndexSeek'))).toBe(true);
      expect(ops).not.toContain('NodeByLabelScan');
      expect(ops).not.toContain('AllNodesScan');
    },
  );

  it('mutuals checks the second user with Expand(Into), not a second fan-out', async () => {
    const { summary } = await g.driver.executeQuery(`EXPLAIN ${loadCypher('mutuals')}`, {
      aId: 'a',
      bId: 'b',
      cursorId: null,
      limit: neo4j.int(21),
    });
    const ops = operators(summary.plan as Plan);
    expect(ops).toContain('Expand(Into)');
    expect(ops.filter((op) => op === 'Expand(All)')).toHaveLength(1);
  });

  const n = (v: number) => neo4j.int(v);
  const pymkQueries: [string, Record<string, unknown>][] = [
    ['pymk-user', { userId: 'a' }],
    ['pymk-fof', { userId: 'a', maxFriends: n(200), maxFanout: n(1000), limit: n(100) }],
    ['pymk-interests', { userId: 'a', maxInterestFanout: n(5000), limit: n(100) }],
    ['pymk-follows-you', { userId: 'a', limit: n(100) }],
    ['pymk-filter', { userId: 'a', ids: ['b', 'c'] }],
    ['pymk-hydrate', { ids: ['b', 'c'] }],
  ];

  it.each(pymkQueries)(
    '%s seeks users by the unique id index and never scans',
    async (name, params) => {
      const { summary } = await g.driver.executeQuery(`EXPLAIN ${loadCypher(name)}`, params);
      const ops = operators(summary.plan as Plan);
      expect(ops.some((op) => op.startsWith('NodeUniqueIndexSeek'))).toBe(true);
      expect(ops).not.toContain('NodeByLabelScan');
      expect(ops).not.toContain('AllNodesScan');
    },
  );

  it('pymk-fof caps the first hop with a LIMIT before expanding friends', async () => {
    const { summary } = await g.driver.executeQuery(`EXPLAIN ${loadCypher('pymk-fof')}`, {
      userId: 'a',
      maxFriends: n(200),
      maxFanout: n(1000),
      limit: n(100),
    });
    // The first-hop cap must be a Top-N over my follows bounded by $maxFriends.
    const details = (plan: Plan): string[] => [
      `${plan.operatorType.replace(/@.*$/, '')} ${plan.arguments.Details ?? ''}`,
      ...plan.children.flatMap(details),
    ];
    expect(details(summary.plan as Plan).some((d) => /^Top .*LIMIT \$maxFriends/.test(d))).toBe(
      true,
    );
  });

  it('pymk-filter checks follows and blocks with Expand(Into), not by fanning out', async () => {
    const { summary } = await g.driver.executeQuery(`EXPLAIN ${loadCypher('pymk-filter')}`, {
      userId: 'a',
      ids: ['b'],
    });
    const ops = operators(summary.plan as Plan);
    expect(ops).toContain('Expand(Into)');
    expect(ops).not.toContain('Expand(All)');
  });
});
