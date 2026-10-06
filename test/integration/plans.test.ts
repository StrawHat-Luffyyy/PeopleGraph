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
});
