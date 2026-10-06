// Measures PYMK cost: friends-of-friends db hits and end-to-end recommend() latency, with
// the first-hop cap at its default (200) and lifted (500). Builds its own graph (ids
// prefixed "pymkm-") in the database from .env and deletes it afterwards. It writes, so
// run it only against a local dev database:
//   npx tsx --env-file=.env scripts/measure-pymk.ts
import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { loadCypher } from '../src/graph/cypher.js';
import { RecoRepository } from '../src/graph/recoRepository.js';
import { recommend } from '../src/reco/pipeline.js';
import { loadConfig } from '../src/shared/config.js';

const FRIENDS = 500; // accounts "me" follows
const PER_FRIEND = 300; // accounts each friend follows (under the 1000 fan-out cap)
const POOL = 20_000; // candidate pool those follows land in
const RUNS = 7;

const config = loadConfig(process.env);
const driver = neo4j.driver(
  config.neo4j.uri,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
);
const timeouts = {
  readTimeoutMs: config.neo4j.readTimeoutMs,
  writeTimeoutMs: config.neo4j.writeTimeoutMs,
};

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
    `MATCH (u:User) WHERE u.id STARTS WITH 'pymkm-'
     CALL (u) { DETACH DELETE u } IN TRANSACTIONS OF 5000 ROWS`,
  );
}

async function build(): Promise<void> {
  await autoCommit(
    `UNWIND range(0, $pool - 1) AS i
     CALL (i) {
       CREATE (:User {id: 'pymkm-t' + i, handle: 'pymkm_t' + i, followerCount: 0, followingCount: 0})
     } IN TRANSACTIONS OF 10000 ROWS`,
    { pool: neo4j.int(POOL) },
  );
  await autoCommit(
    `CREATE (:User {id: 'pymkm-me', handle: 'pymkm_me', followerCount: 0, followingCount: $friends})`,
    { friends: neo4j.int(FRIENDS) },
  );
  // me follows each friend; later friends are followed more recently.
  await autoCommit(
    `MATCH (me:User {id: 'pymkm-me'})
     UNWIND range(0, $friends - 1) AS i
     CREATE (me)-[:FOLLOWS {since: datetime('2025-01-01T00:00:00Z') + duration({seconds: i})}]->
            (:User {id: 'pymkm-f' + i, handle: 'pymkm_f' + i, followerCount: 1, followingCount: $per})`,
    { friends: neo4j.int(FRIENDS), per: neo4j.int(PER_FRIEND) },
  );
  // Friend i follows PER_FRIEND distinct pool members (4729 is coprime with 20000).
  await autoCommit(
    `UNWIND range(0, $friends - 1) AS i
     CALL (i) {
       MATCH (f:User {id: 'pymkm-f' + i})
       UNWIND range(0, $per - 1) AS j
       MATCH (t:User {id: 'pymkm-t' + ((i * 7919 + j * 4729) % $pool)})
       CREATE (f)-[:FOLLOWS {since: datetime()}]->(t)
       SET t.followerCount = t.followerCount + 1
     } IN TRANSACTIONS OF 20 ROWS`,
    { friends: neo4j.int(FRIENDS), per: neo4j.int(PER_FRIEND), pool: neo4j.int(POOL) },
  );
  // me also follows 50 pool members (older follows), so already-followed candidates
  // really occur and must be excluded, as in real graphs.
  await autoCommit(
    `MATCH (me:User {id: 'pymkm-me'})
     UNWIND range(0, 49) AS k
     MATCH (t:User {id: 'pymkm-t' + (k * 397)})
     CREATE (me)-[:FOLLOWS {since: datetime('2024-01-01T00:00:00Z')}]->(t)
     SET me.followingCount = me.followingCount + 1, t.followerCount = t.followerCount + 1`,
  );
}

async function measure(maxFriends: number) {
  const { summary } = await driver.executeQuery(`PROFILE ${loadCypher('pymk-fof')}`, {
    userId: 'pymkm-me',
    maxFriends: neo4j.int(maxFriends),
    maxFanout: neo4j.int(config.pymk.maxFanout),
    limit: neo4j.int(config.pymk.candidatesPerSource),
  });
  if (summary.profile === false) throw new Error('no profile');

  const { weights, ...bounds } = config.pymk;
  const repo = new RecoRepository(driver, timeouts, { ...bounds, maxFriends });
  const run = () => recommend('pymkm-me', 20, repo, weights);
  const top = await run(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    fofHits: totalHits(summary.profile),
    medianMs: times[Math.floor(RUNS / 2)] ?? NaN,
    top: top[0]?.explanation ?? '(none)',
  };
}

try {
  await cleanup();
  await build();
  const capped = await measure(config.pymk.maxFriends);
  const uncapped = await measure(FRIENDS);
  process.stdout.write(
    `graph: ${POOL + FRIENDS + 1} users, ${FRIENDS + 50 + FRIENDS * PER_FRIEND} FOLLOWS edges\n\n` +
      '| maxFriends | friends-of-friends db hits | recommend() median ms (7 warm runs) | top result |\n' +
      '| ---: | ---: | ---: | --- |\n',
  );
  for (const [label, r] of [
    [`${config.pymk.maxFriends} (default)`, capped],
    [`${FRIENDS} (all friends)`, uncapped],
  ] as const) {
    process.stdout.write(
      `| ${label} | ${r.fofHits.toLocaleString('en-US')} | ${r.medianMs.toFixed(1)} | ${r.top} |\n`,
    );
  }
} finally {
  await cleanup();
  await driver.close();
}
