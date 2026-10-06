// Prints PROFILE plans (operators, rows, db hits) for the write and read Cypher files against
// the database in .env (docker-compose by default). It EXECUTES the writes, so run it only
// against a local dev database. Usage: npx tsx --env-file=.env scripts/profile-queries.ts
import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { loadCypher } from '../src/graph/cypher.js';
import { applySchema } from '../src/graph/schema.js';
import { loadConfig } from '../src/shared/config.js';

const config = loadConfig(process.env);
const driver = neo4j.driver(
  config.neo4j.uri,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
);

const A = 'profile-a';
const B = 'profile-b';
const C = 'profile-c';
const firstPage = { cursorSince: null, cursorId: null, limit: neo4j.int(21) };
const cases: [string, Record<string, unknown>][] = [
  ['create-user', { id: A, handle: 'profile_a', name: 'Profile A' }],
  ['create-user', { id: B, handle: 'profile_b', name: 'Profile B' }],
  ['create-user', { id: C, handle: 'profile_c', name: 'Profile C' }],
  ['lock-users', { ids: [A, B] }],
  ['replace-interests', { userId: A, interests: ['profile-rust', 'profile-chess'] }],
  ['follow', { followerId: A, targetId: B }],
  ['follow', { followerId: C, targetId: B }],
  ['followers', { userId: B, ...firstPage }],
  ['following', { userId: A, ...firstPage }],
  ['mutuals', { aId: A, bId: C, cursorId: null, limit: neo4j.int(21) }],
  ['follow', { followerId: B, targetId: A }],
  ['pymk-user', { userId: C }],
  [
    'pymk-fof',
    { userId: C, maxFriends: neo4j.int(200), maxFanout: neo4j.int(1000), limit: neo4j.int(100) },
  ],
  ['pymk-interests', { userId: A, maxInterestFanout: neo4j.int(5000), limit: neo4j.int(100) }],
  ['pymk-follows-you', { userId: B, limit: neo4j.int(100) }],
  ['pymk-filter', { userId: C, ids: [A, B] }],
  ['pymk-hydrate', { ids: [A, B, C] }],
  ['unfollow', { followerId: A, targetId: B }],
  ['block', { blockerId: A, targetId: B }],
  ['counter-drift', { limit: neo4j.int(100) }],
];

function render(plan: ProfiledPlan, depth = 0): string[] {
  const detail = typeof plan.arguments.Details === 'string' ? ` ${plan.arguments.Details}` : '';
  const line = `${'  '.repeat(depth)}${plan.operatorType}${detail} | rows=${plan.rows} dbHits=${plan.dbHits}`;
  return [line, ...plan.children.flatMap((c) => render(c, depth + 1))];
}

function totalHits(plan: ProfiledPlan): number {
  return plan.dbHits + plan.children.reduce((sum, c) => sum + totalHits(c), 0);
}

try {
  await applySchema(driver);
  for (const [name, params] of cases) {
    const { summary } = await driver.executeQuery(`PROFILE ${loadCypher(name)}`, params);
    const plan = summary.profile;
    if (plan === false) throw new Error(`no profile for ${name}`);
    process.stdout.write(`### ${name} (total dbHits ${totalHits(plan)})\n\n\`\`\`\n`);
    process.stdout.write(`${render(plan).join('\n')}\n\`\`\`\n\n`);
  }
  await driver.executeQuery('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u', {
    ids: [A, B, C],
  });
  // Interest names are prefixed so this only removes what the script created.
  await driver.executeQuery("MATCH (i:Interest) WHERE i.name STARTS WITH 'profile-' DELETE i");
} finally {
  await driver.close();
}
