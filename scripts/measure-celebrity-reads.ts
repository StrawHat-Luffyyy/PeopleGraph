// Measures read-path cost on a celebrity: followers page 1 vs a deep page, and mutuals
// against an account that follows many people. Creates its own nodes (ids prefixed
// "celebm-") in the database from .env and deletes them afterwards. It writes, so run it
// only against a local dev database:
//   npx tsx --env-file=.env scripts/measure-celebrity-reads.ts
import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { loadCypher } from '../src/graph/cypher.js';
import { loadConfig } from '../src/shared/config.js';

const FOLLOWERS = 100_000;
const BIG_FOLLOWING = 20_000;
const RUNS = 7;

const config = loadConfig(process.env);
const driver = neo4j.driver(
  config.neo4j.uri,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
);

const totalHits = (p: ProfiledPlan): number =>
  p.dbHits + p.children.reduce((sum, c) => sum + totalHits(c), 0);

// IN TRANSACTIONS needs an implicit (auto-commit) transaction.
async function autoCommit(query: string, params: Record<string, unknown> = {}): Promise<void> {
  const session = driver.session();
  try {
    await session.run(query, params);
  } finally {
    await session.close();
  }
}

async function cleanup(): Promise<void> {
  await autoCommit(
    `MATCH (u:User) WHERE u.id STARTS WITH 'celebm-'
     CALL (u) { DETACH DELETE u } IN TRANSACTIONS OF 5000 ROWS`,
  );
}

async function measure(name: string, params: Record<string, unknown>, text?: string) {
  const query = text ?? loadCypher(name);
  const { summary } = await driver.executeQuery(`PROFILE ${query}`, params);
  if (summary.profile === false) throw new Error('no profile');
  const hits = totalHits(summary.profile);
  await driver.executeQuery(query, params); // warm-up
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await driver.executeQuery(query, params);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { hits, medianMs: times[Math.floor(RUNS / 2)] ?? NaN };
}

try {
  await cleanup();
  // Celebrity with 100k followers, one distinct `since` per edge (1 s apart).
  await autoCommit(
    `CREATE (:User {id: 'celebm-star', handle: 'celebm_star', followerCount: $n, followingCount: 0})`,
    { n: neo4j.int(FOLLOWERS) },
  );
  await autoCommit(
    `MATCH (s:User {id: 'celebm-star'})
     UNWIND range(1, $n) AS i
     CALL (s, i) {
       CREATE (f:User {id: 'celebm-f' + i, handle: 'celebm_f' + i, followerCount: 0, followingCount: 1})
       CREATE (f)-[:FOLLOWS {since: datetime('2025-01-01T00:00:00Z') + duration({seconds: i})}]->(s)
     } IN TRANSACTIONS OF 10000 ROWS`,
    { n: neo4j.int(FOLLOWERS) },
  );
  // "big" follows 20k of those fans; "small" follows 10 of them (5 shared with big).
  await autoCommit(
    `CREATE (:User {id: 'celebm-big', handle: 'celebm_big', followerCount: 0, followingCount: $k}),
            (:User {id: 'celebm-small', handle: 'celebm_small', followerCount: 0, followingCount: 10})`,
    { k: neo4j.int(BIG_FOLLOWING) },
  );
  await autoCommit(
    `MATCH (b:User {id: 'celebm-big'})
     UNWIND range(1, $k) AS i
     CALL (b, i) {
       MATCH (f:User {id: 'celebm-f' + i})
       CREATE (b)-[:FOLLOWS {since: datetime()}]->(f)
     } IN TRANSACTIONS OF 10000 ROWS`,
    { k: neo4j.int(BIG_FOLLOWING) },
  );
  await autoCommit(
    `MATCH (s:User {id: 'celebm-small'})
     UNWIND [1, 2, 3, 4, 5, 50001, 50002, 50003, 50004, 50005] AS i
     MATCH (f:User {id: 'celebm-f' + i})
     CREATE (s)-[:FOLLOWS {since: datetime()}]->(f)`,
  );

  // Deep page cursor: the follower ~90% of the way down the newest-first list.
  const deepIndex = Math.round(FOLLOWERS * 0.1);
  const { records } = await driver.executeQuery(
    `MATCH (:User {id: 'celebm-f' + $i})-[f:FOLLOWS]->(:User {id: 'celebm-star'})
     RETURN toString(f.since) AS since`,
    { i: neo4j.int(deepIndex) },
  );
  const deepSince = records[0]?.get('since') as string;

  const page = { cursorId: null, limit: neo4j.int(21) };
  const results = {
    'followers page 1 (100k followers)': await measure('followers', {
      userId: 'celebm-star',
      cursorSince: null,
      ...page,
    }),
    'followers deep page (~90% down)': await measure('followers', {
      userId: 'celebm-star',
      cursorSince: deepSince,
      cursorId: `celebm-f${deepIndex}`,
      limit: neo4j.int(21),
    }),
    'following page 1 (normal fan)': await measure('following', {
      userId: 'celebm-f1',
      cursorSince: null,
      ...page,
    }),
    'mutuals small(10) x big(20k)': await measure('mutuals', {
      aId: 'celebm-small',
      bId: 'celebm-big',
      ...page,
    }),
    'mutuals big(20k) x small(10)': await measure('mutuals', {
      aId: 'celebm-big',
      bId: 'celebm-small',
      ...page,
    }),
    // Baseline for the followingCount choice: same query, always expanding from $aId.
    'mutuals forced to expand from big(20k)': await measure(
      'mutuals',
      { aId: 'celebm-big', bId: 'celebm-small', ...page },
      loadCypher('mutuals').replace(/WITH CASE[^\n]*\n/, 'WITH [a, b] AS pair\n'),
    ),
  };
  process.stdout.write(
    '| query | total db hits | median ms (7 warm runs) |\n| --- | ---: | ---: |\n',
  );
  for (const [label, r] of Object.entries(results)) {
    process.stdout.write(
      `| ${label} | ${r.hits.toLocaleString('en-US')} | ${r.medianMs.toFixed(1)} |\n`,
    );
  }
} finally {
  await cleanup();
  await driver.close();
}
