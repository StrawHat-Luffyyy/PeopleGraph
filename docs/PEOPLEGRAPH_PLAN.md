# PeopleGraph: Social Graph Service with "People You May Know"

**Stack:** TypeScript, Hono, Neo4j 5, Redis 7 (Lua), Postgres (benchmark baseline only), Vitest + Testcontainers, Docker, GitHub Actions
**Teaches:** Neo4j modeling and Cypher, graph traversals, recommendation pipelines, supernodes, rate limiting, caching (stampede, stale-while-revalidate), pagination, denormalization, and benchmarking graph vs relational.

## 1. Problem

Users follow each other and declare interests. The service must:

- Follow, unfollow, and block, safely under concurrency and spam.
- List followers and following with stable pagination.
- Show mutual connections between two users.
- Recommend "people you may know" (PYMK) with a human-readable reason ("followed by ana, raj and 5 others").
- Answer "how many hops between A and B?"

The hard parts are not the CRUD. They are: celebrity nodes (supernodes), recommendation quality, protecting an expensive query, and proving where a graph database beats SQL and where it doesn't.

## 2. Architecture

```
Client
  |
Hono API (auth header -> userId)
  |-- rate limiter (Redis Lua token bucket + daily cap)
  |-- PYMK cache (Redis, stale-while-revalidate, refresh lock)
  |
  |-- Neo4j  (users, follows, blocks, interests)
  |-- Postgres (benchmark baseline copy of the follow table, Phase 6 only)
```

### PYMK pipeline (the core design, record as ADR-001)

1. **Generate candidates** with several independent Cypher queries: friends-of-friends, shared interests, people who follow you but you don't follow back.
2. **Blend and score** in a pure TypeScript function (weights are config).
3. **Filter** (already following, blocked either way, self).
4. **Hydrate** the top N in one query.
5. **Explain** each result from the candidate sources that produced it.

Keeping scoring in TypeScript makes it unit-testable and tunable without touching Cypher.

## 3. Graph schema

```
(:User     {id, handle, name, followerCount, followingCount, createdAt})
(:Interest {name})

(:User)-[:FOLLOWS       {since}]->(:User)
(:User)-[:BLOCKED       {since}]->(:User)
(:User)-[:INTERESTED_IN]->(:Interest)
```

Design decisions:

- `followerCount` and `followingCount` are **denormalized** counters, updated in the same transaction as the edge change. They let you cap fan-out cheaply (skip accounts that follow 50,000 people). Phase 4 includes an experiment comparing them against `COUNT { }` subqueries, since Neo4j can read degrees cheaply for dense nodes. Keep the counters only if you can show they help.
- Blocking is its own relationship type and deletes follow edges in both directions.
- Interest names are normalized (lowercase, trimmed) in TypeScript before they hit the database.

### Constraints and indexes (run at startup, idempotent)

```cypher
CREATE CONSTRAINT user_id     IF NOT EXISTS FOR (u:User)     REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT user_handle IF NOT EXISTS FOR (u:User)     REQUIRE u.handle IS UNIQUE;
CREATE CONSTRAINT interest_nm IF NOT EXISTS FOR (i:Interest) REQUIRE i.name IS UNIQUE;
```

A duplicate handle raises a constraint violation. Map it to HTTP `409`.

## 4. API

| Method | Path                                     | Purpose                                            |
| ------ | ---------------------------------------- | -------------------------------------------------- |
| POST   | `/v1/users`                              | create user                                        |
| PUT    | `/v1/users/:id/interests`                | replace interests                                  |
| POST   | `/v1/follow/:targetId`                   | follow (caller from `X-User-Id` in dev, JWT later) |
| DELETE | `/v1/follow/:targetId`                   | unfollow (idempotent)                              |
| POST   | `/v1/block/:targetId`                    | block                                              |
| GET    | `/v1/users/:id/followers?cursor=&limit=` | keyset pagination                                  |
| GET    | `/v1/users/:id/following?cursor=&limit=` | keyset pagination                                  |
| GET    | `/v1/users/:id/mutuals/:otherId`         | mutual connections                                 |
| GET    | `/v1/recommendations/people`             | PYMK for the caller                                |
| GET    | `/v1/users/:id/distance/:otherId`        | hops between two users                             |

## 5. Core Cypher

All queries are parameterized. Never build Cypher with string concatenation.

**Create a user (idempotent)**

```cypher
MERGE (u:User {id: $id})
  ON CREATE SET u.handle = $handle, u.name = $name,
                u.followerCount = 0, u.followingCount = 0,
                u.createdAt = datetime()
RETURN u.id AS id
```

**Replace interests**

```cypher
MATCH (u:User {id: $userId})
OPTIONAL MATCH (u)-[old:INTERESTED_IN]->()
DELETE old
WITH DISTINCT u
UNWIND $interests AS name
MERGE (i:Interest {name: name})
MERGE (u)-[:INTERESTED_IN]->(i)
```

**Follow (idempotent, counters only change on a new edge)**

```cypher
MATCH (a:User {id: $followerId}), (b:User {id: $targetId})
WHERE a <> b AND NOT EXISTS { (a)-[:BLOCKED]-(b) }
MERGE (a)-[f:FOLLOWS]->(b)
  ON CREATE SET f.since = datetime(), f.isNew = true,
                a.followingCount = a.followingCount + 1,
                b.followerCount  = b.followerCount + 1
WITH f, coalesce(f.isNew, false) AS created
REMOVE f.isNew
RETURN created
```

Zero rows means a missing user, self-follow, or a block. Run a small diagnostic query to choose between `404` and `403`. Concurrent follows of the same pair must still produce exactly one edge and a count of 1 (test this). Opposite-direction follows can hit deadlocks. Use managed transactions so the driver retries transient errors.

**Unfollow (idempotent)**

```cypher
MATCH (a:User {id: $followerId})-[f:FOLLOWS]->(b:User {id: $targetId})
DELETE f
SET a.followingCount = a.followingCount - 1,
    b.followerCount  = b.followerCount - 1
RETURN true AS removed
```

Zero rows means nothing to remove, which is still success (`204`).

**Block (removes follows in both directions, fixes counters)**

```cypher
MATCH (a:User {id: $blockerId}), (b:User {id: $targetId})
WHERE a <> b
MERGE (a)-[bl:BLOCKED]->(b)
  ON CREATE SET bl.since = datetime()
WITH a, b
OPTIONAL MATCH (a)-[f1:FOLLOWS]->(b)
OPTIONAL MATCH (b)-[f2:FOLLOWS]->(a)
FOREACH (_ IN CASE WHEN f1 IS NULL THEN [] ELSE [1] END |
  SET a.followingCount = a.followingCount - 1,
      b.followerCount  = b.followerCount - 1
  DELETE f1)
FOREACH (_ IN CASE WHEN f2 IS NULL THEN [] ELSE [1] END |
  SET b.followingCount = b.followingCount - 1,
      a.followerCount  = a.followerCount - 1
  DELETE f2)
RETURN true AS blocked
```

This is the trickiest write. Write the test first: block someone who follows you, who you follow, both, and neither, then assert the counters.

**Followers with keyset pagination** (following is the mirror image)

```cypher
MATCH (u:User {id: $userId})<-[f:FOLLOWS]-(x:User)
WHERE $cursorSince IS NULL
   OR f.since < $cursorSince
   OR (f.since = $cursorSince AND x.id < $cursorId)
RETURN x.id AS id, x.handle AS handle, f.since AS since
ORDER BY f.since DESC, x.id DESC
LIMIT $limit
```

The cursor is `(since, id)`, base64-encoded. Offset pagination (`SKIP`) gets slower and unstable as data changes. Caveat: this sorts all of a user's followers on every page. `PROFILE` it on a celebrity node and see how it behaves. If it hurts, try a relationship property index on `since`, or paginate by a monotonic id instead.

**Mutual connections**

```cypher
MATCH (a:User {id: $aId})-[:FOLLOWS]->(m:User)<-[:FOLLOWS]-(b:User {id: $bId})
RETURN m.id AS id, m.handle AS handle
LIMIT $limit
```

**Candidate generator 1: friends-of-friends**

```cypher
MATCH (me:User {id: $userId})-[:FOLLOWS]->(f:User)
WHERE f.followingCount <= $maxFanout
MATCH (f)-[:FOLLOWS]->(c:User)
WHERE c.id <> $userId
  AND NOT EXISTS { (me)-[:FOLLOWS]->(c) }
  AND NOT EXISTS { (me)-[:BLOCKED]-(c) }
WITH c, count(DISTINCT f) AS mutualCount,
        collect(DISTINCT f.handle)[..3] AS sampleMutuals
RETURN c.id AS id, mutualCount, sampleMutuals
ORDER BY mutualCount DESC
LIMIT $limit
```

`maxFanout` is the supernode guard: don't expand through accounts that follow huge numbers of people.

**Candidate generator 2: shared interests**

```cypher
MATCH (me:User {id: $userId})-[:INTERESTED_IN]->(i:Interest)<-[:INTERESTED_IN]-(c:User)
WHERE c.id <> $userId
  AND NOT EXISTS { (me)-[:FOLLOWS]->(c) }
  AND NOT EXISTS { (me)-[:BLOCKED]-(c) }
WITH c, count(DISTINCT i) AS sharedInterests,
        collect(DISTINCT i.name)[..3] AS sampleInterests
RETURN c.id AS id, sharedInterests, sampleInterests
ORDER BY sharedInterests DESC
LIMIT $limit
```

A very popular interest is its own supernode. Exercise: add a popularity cap.

**Candidate generator 3: followers you don't follow back**

```cypher
MATCH (me:User {id: $userId})<-[:FOLLOWS]-(c:User)
WHERE NOT EXISTS { (me)-[:FOLLOWS]->(c) }
  AND NOT EXISTS { (me)-[:BLOCKED]-(c) }
RETURN c.id AS id
LIMIT $limit
```

**Hydrate the top N**

```cypher
MATCH (u:User)
WHERE u.id IN $ids
RETURN u.id AS id, u.handle AS handle, u.name AS name, u.followerCount AS followerCount
```

**Degrees of separation**

```cypher
MATCH (a:User {id: $aId}), (b:User {id: $bId})
MATCH p = shortestPath((a)-[:FOLLOWS*..6]->(b))
RETURN [n IN nodes(p) | n.handle] AS path, length(p) AS hops
```

Always bound the depth.

**Counter drift detector (use in tests and a periodic job)**

```cypher
MATCH (u:User)
WITH u, COUNT { (u)<-[:FOLLOWS]-() } AS followers, COUNT { (u)-[:FOLLOWS]->() } AS following
WHERE u.followerCount <> followers OR u.followingCount <> following
RETURN u.id AS id, u.followerCount AS stored, followers AS actual
LIMIT 100
```

After every integration test that mutates the graph, this must return zero rows.

**Bulk load edges**

```cypher
UNWIND $rows AS row
MATCH (a:User {id: row.from}), (b:User {id: row.to})
MERGE (a)-[f:FOLLOWS]->(b)
  ON CREATE SET f.since = datetime(row.since)
```

Send batches of 5,000 to 10,000 rows. Then backfill counters (run as an auto-commit query, not inside a managed transaction, because `IN TRANSACTIONS` requires that):

```cypher
MATCH (u:User)
CALL {
  WITH u
  SET u.followerCount  = COUNT { (u)<-[:FOLLOWS]-() },
      u.followingCount = COUNT { (u)-[:FOLLOWS]->() }
} IN TRANSACTIONS OF 10000 ROWS
```

## 6. Scoring (pure TypeScript)

```
score = wMutual * mutualCount
      + wInterest * sharedInterests
      + wFollowsYou * (followsYou ? 1 : 0)
```

Start with `wMutual=3, wInterest=2, wFollowsYou=5`. Tune them in Phase 7 using the evaluation, not by feel. The explanation string comes from whichever sources contributed ("followed by ana, raj"; "shares interests: rust, chess").

## 7. Rate limiting and caching (Redis)

**Token bucket (Lua, atomic, Redis time)**

```lua
-- KEYS[1] bucket key
-- ARGV[1] capacity, ARGV[2] refill per second (> 0), ARGV[3] cost
-- returns {allowed (1/0), tokensLeft, retryAfterMs}
local t   = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local cap, rate, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])

local d  = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tk = tonumber(d[1])
local ts = tonumber(d[2])
if tk == nil then tk, ts = cap, now end

tk = math.min(cap, tk + math.max(0, now - ts) * rate / 1000)

local allowed, wait = 0, 0
if tk >= cost then
  tk = tk - cost
  allowed = 1
else
  wait = math.ceil((cost - tk) / rate * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tk, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) * 2)
return { allowed, math.floor(tk), wait }
```

Suggested limits (make them config):

- Follow: burst 10, refill 0.5/s (about 30 per minute), plus a daily cap of 200 using `INCR` with an expiry. This stops follow-spam.
- PYMK endpoint: burst 5, refill 1 per 10 s. It is the expensive query, so protect it.
- Return `429` with `Retry-After` and `RateLimit-*` headers.

**PYMK cache with stale-while-revalidate**

- Key `pymk:{userId}` stores `{items, computedAt}`.
- Fresh (under 5 min): serve it.
- Stale (5 to 30 min): serve it and trigger one background refresh, guarded by `SET pymk:lock:{userId} 1 NX PX 5000` so concurrent requests don't all recompute.
- Missing: compute synchronously, still holding the lock. Other callers briefly wait or get an empty list with a short retry hint.
- On follow, unfollow, or block by a user, delete their cache key.

## 8. Phases

### Phase 0: Scaffolding (half a day)

- `docker-compose.yml` with `neo4j:5` (community) and `redis:7`. Add `CLAUDE.md`, strict TypeScript, Vitest, Testcontainers, and a CI workflow (lint, typecheck, tests).
- **Done when:** CI is green on a health-check test that talks to both containers.

### Phase 1: Graph model and write paths

- Constraints at startup, create user, interests, follow, unfollow, block.
- Managed transactions (`executeRead` / `executeWrite`), sessions closed, driver `Integer` converted at the repository boundary.
- **Tests:**
  - Follow is idempotent and counters stay correct.
  - Self-follow and blocked follow are rejected.
  - 100 concurrent follows of the same pair produce one edge and `followerCount == 1`.
  - Block removes edges in both directions and fixes counters.
  - The drift detector returns zero rows after every test.
- **Learn:** `MERGE` semantics, constraints, why unlabeled matches scan everything, transient-error retries.

### Phase 2: Read paths

- Followers, following, mutuals, with keyset pagination (max page size 100).
- **Tests:** pagination has no duplicates or gaps while new follows arrive between pages.
- Run `PROFILE` on each query and save the plan and db hits in `docs/`.
- **Learn:** reading query plans, expand vs index seek, why keyset beats `SKIP`.

### Phase 3: PYMK v1

- The three candidate generators, the TypeScript blender, the filter, hydration, and explanations.
- **Tests:** a small hand-built graph where the right answer is obvious. Cover: candidates exclude already-followed, blocked, and self; ranking order; explanation text; the fan-out cap really skips big accounts.
- **Learn:** candidate generation, scoring, and filtering as separate stages, plus supernode mitigation.

### Phase 4: Scale and data generation

- Generate a power-law graph (preferential attachment) with about 100,000 users and a few million edges, with planted communities so recommendations have real structure. Bulk load in batches and backfill counters.
- Experiment: counters vs `COUNT { }` for the fan-out cap. Record the numbers and decide.
- Find your slowest query on a celebrity node and fix it (cap, index, or restructure).
- **Learn:** why synthetic data shape matters, batch ingestion, supernodes in practice.

### Phase 5: Rate limiting and caching

- Token bucket Lua, daily cap, limiter middleware, PYMK cache with stale-while-revalidate and the refresh lock.
- **Tests:** 1,000 concurrent follow attempts with burst 10 allow exactly 10; the bucket refills over time; 200 concurrent cold PYMK requests cause one computation; cache is invalidated after a follow.
- Implement a sliding window counter as a second algorithm and compare burst behavior at window edges.
- **Learn:** atomicity, token bucket vs window counters, stampede protection, stale-while-revalidate.

### Phase 6: Graph vs Postgres benchmark

Copy the follow table into Postgres (`follows(follower_id, followee_id, since)`, primary key on both columns, index on `followee_id`) and compare the same questions.

2-hop PYMK in SQL:

```sql
SELECT f2.followee_id AS candidate, count(*) AS mutuals
FROM follows f1
JOIN follows f2 ON f2.follower_id = f1.followee_id
WHERE f1.follower_id = $1
  AND f2.followee_id <> $1
  AND NOT EXISTS (
    SELECT 1 FROM follows x
    WHERE x.follower_id = $1 AND x.followee_id = f2.followee_id)
GROUP BY f2.followee_id
ORDER BY mutuals DESC
LIMIT 20;
```

Shortest path in SQL (recursive CTE):

```sql
WITH RECURSIVE walk AS (
  SELECT followee_id AS node, 1 AS depth, ARRAY[follower_id, followee_id] AS path
  FROM follows WHERE follower_id = $1
  UNION ALL
  SELECT f.followee_id, w.depth + 1, w.path || f.followee_id
  FROM walk w JOIN follows f ON f.follower_id = w.node
  WHERE w.depth < 6 AND NOT f.followee_id = ANY(w.path)
)
SELECT depth, path FROM walk WHERE node = $2 ORDER BY depth LIMIT 1;
```

Benchmark 2-hop, 3-hop, and shortest path at depth 4 to 6, at several graph sizes, on warm and cold caches, with p50 and p99. Expect Postgres to be competitive at 2 hops with good indexes. The gap, if any, should show up at deeper traversals. Report what you measure, including results that favor Postgres.

### Phase 7: Recommendation quality

- Evaluation: pick a sample of users, hide 20% of their follow edges, run PYMK, and measure recall@10 and precision@10 against the hidden edges.
- This only means something if the synthetic graph has planted structure (communities). On a purely random graph the numbers are noise.
- Compare variants: mutuals only, interests only, blended. Tune the weights against the metric and record before/after.
- **Learn:** offline evaluation, precision/recall, why you measure instead of guessing.

### Phase 8: Hardening and write-up

- Query timeouts on Neo4j transactions, max page and depth limits, JWT auth replacing the dev header, structured logs (no PII), Prometheus metrics (latency, cache hit ratio, 429 count).
- k6 load test: warm cache, cold cache, celebrity-heavy traffic.
- README with architecture diagram, ADRs (PYMK pipeline, counters decision, cache design), and a results table of numbers you measured.

## 9. Interview questions this prepares you for

- Design "people you may know" or a friend-suggestion system. Walk through candidate generation, ranking, filtering, serving, and caching.
- The celebrity problem: how do you stop one account from wrecking a traversal?
- Design a rate limiter for a follow endpoint. Why Lua? Token bucket vs sliding window?
- Cache stampede and stale-while-revalidate.
- Offset vs keyset pagination.
- When is denormalization (counters) worth it, and how do you detect drift?
- Idempotency and concurrency for writes.
- When does a graph database beat SQL, and when doesn't it? (Know your Phase 6 numbers.)
- How would you evaluate a recommender offline?
- How would you scale this to 100M users? (Sharding a graph is hard. Discuss partitioning by community, precomputing candidates offline, and serving from a cache or key-value store.)

## 10. Stretch goals

- Neo4j Graph Data Science: Node Similarity, Louvain communities, FastRP embeddings as a fourth candidate generator.
- A follower-feed or activity stream layered on the same graph.
- "Suggested accounts to unfollow" or spam-ring detection using shared-follower patterns.
- Deploy on Neo4j Aura with a Cloudflare-fronted API.
