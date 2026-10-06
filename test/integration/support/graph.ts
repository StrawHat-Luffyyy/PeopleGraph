import neo4j from 'neo4j-driver';
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject } from 'vitest';
import { createDriver, type Driver } from '../../../src/graph/driver.js';
import { applySchema } from '../../../src/graph/schema.js';
import { SocialRepository } from '../../../src/graph/socialRepository.js';
import { UserRepository } from '../../../src/graph/userRepository.js';

export const timeouts = { readTimeoutMs: 5000, writeTimeoutMs: 30_000 };

export interface GraphFixture {
  driver: Driver;
  users: UserRepository;
  social: SocialRepository;
}

/**
 * Registers hooks that give each test an empty graph with the schema applied, and assert
 * the counter-drift detector returns zero rows after every test (CLAUDE.md invariant 2).
 */
export function useGraph(): GraphFixture {
  const fixture = {} as GraphFixture;

  beforeAll(async () => {
    fixture.driver = createDriver({
      uri: inject('neo4jUri'),
      user: 'neo4j',
      password: inject('neo4jPassword'),
      ...timeouts,
    });
    fixture.users = new UserRepository(fixture.driver, timeouts);
    fixture.social = new SocialRepository(fixture.driver, timeouts);
    await applySchema(fixture.driver);
  });

  beforeEach(async () => {
    // Test-only full wipe; the graph here is a handful of nodes.
    await fixture.driver.executeQuery('MATCH (n) DETACH DELETE n');
  });

  afterEach(async () => {
    expect(await fixture.social.findCounterDrift()).toEqual([]);
  });

  afterAll(async () => {
    await fixture.driver.close();
  });

  return fixture;
}

// Assertion helpers below read the graph with raw Cypher, independently of the
// repository code under test.

export async function createUsers(users: UserRepository, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await users.createUser({ id, handle: `h_${id}`.toLowerCase(), name: `Name ${id}` });
  }
}

export async function counters(
  driver: Driver,
  id: string,
): Promise<{ followers: number; following: number }> {
  const { records } = await driver.executeQuery(
    'MATCH (u:User {id: $id}) RETURN u.followerCount AS followers, u.followingCount AS following',
    { id },
  );
  const r = records[0];
  if (r === undefined) throw new Error(`user ${id} not found`);
  return {
    followers: neo4j.integer.toNumber(r.get('followers') as number),
    following: neo4j.integer.toNumber(r.get('following') as number),
  };
}

const EDGE_COUNT = {
  FOLLOWS: 'MATCH (:User {id: $from})-[r:FOLLOWS]->(:User {id: $to}) RETURN count(r) AS n',
  BLOCKED: 'MATCH (:User {id: $from})-[r:BLOCKED]->(:User {id: $to}) RETURN count(r) AS n',
} as const;

export async function edgeCount(
  driver: Driver,
  type: keyof typeof EDGE_COUNT,
  from: string,
  to: string,
): Promise<number> {
  const { records } = await driver.executeQuery(EDGE_COUNT[type], { from, to });
  return neo4j.integer.toNumber(records[0]?.get('n') as number);
}

export async function interestsOf(driver: Driver, id: string): Promise<string[]> {
  const { records } = await driver.executeQuery(
    'MATCH (:User {id: $id})-[:INTERESTED_IN]->(i:Interest) RETURN i.name AS name ORDER BY name',
    { id },
  );
  return records.map((r) => r.get('name') as string);
}

const NODE_COUNT = {
  User: 'MATCH (n:User) RETURN count(n) AS n',
  Interest: 'MATCH (n:Interest) RETURN count(n) AS n',
} as const;

export async function nodeCount(driver: Driver, label: keyof typeof NODE_COUNT): Promise<number> {
  const { records } = await driver.executeQuery(NODE_COUNT[label]);
  return neo4j.integer.toNumber(records[0]?.get('n') as number);
}
