# PeopleGraph

Social graph service with "people you may know" recommendations. Neo4j stores users, follows, blocks, and interests. Redis provides rate limiting and a recommendation cache. Postgres exists only as a benchmark baseline. Read `docs/PEOPLEGRAPH_PLAN.md` for the full design and phases.

## Stack

Node 22, TypeScript (strict), Hono, neo4j-driver (Neo4j 5), ioredis (Redis 7), pg (benchmark only), Vitest, Testcontainers, fast-check, pino, prom-client, k6, Docker Compose.

## Layout

```
src/api/        Hono routes, middleware (auth, rate limit), request validation
src/graph/      driver setup, repositories, cypher/*.cypher query files
src/reco/       candidate generators, scoring (pure), filtering, explanations
src/limiter/    token bucket and window counter, lua/*.lua
src/cache/      PYMK cache, refresh lock
src/shared/     types, config, errors
bench/          data generator, bulk loader, Postgres baseline, k6 scripts
test/unit  test/integration  test/eval
docs/adr/       architecture decision records
```

## Commands

```
docker compose up -d          # neo4j + redis (+ postgres for benchmarks)
npm run dev                   # API
npm test                      # unit tests
npm run test:integration      # Testcontainers (needs Docker)
npm run typecheck && npm run lint
npm run bench:seed            # generate and load the power-law graph
```

## Core invariants (never violate)

1. All graph writes are idempotent: `MERGE` on uniquely constrained properties.
2. `followerCount` and `followingCount` change only inside the follow, unfollow, and block queries, in the same transaction as the edge change. After any mutating test, the counter drift query must return zero rows.
3. Every traversal is bounded: a `LIMIT`, a depth cap, or a fan-out cap. No unbounded expansion, ever.
4. List endpoints never return unbounded results. Max page size is 100. Use keyset pagination, never `SKIP`.
5. Limiter state changes only inside Lua scripts, and time comes from Redis `TIME`, never `Date.now()`.
6. The recommendation pipeline stays staged: generate candidates (Cypher) then score (pure TS) then filter then hydrate. Scoring is a pure function with unit tests.
7. Never log PII (names, emails, bios). Log ids only.

## Neo4j conventions

- Parameterized Cypher only. Never concatenate input into a query.
- Queries live in `src/graph/cypher/*.cypher` and are loaded by repositories.
- Always match with a label (`MATCH (u:User {id: $id})`). Unlabeled matches scan every node.
- Use `executeRead` / `executeWrite` managed transactions so transient errors (deadlocks) are retried. Always close sessions. Set a transaction timeout on reads.
- Convert driver `Integer` values at the repository boundary. Nothing above `src/graph/` sees them.
- Run `PROFILE` on any new or changed query and save notable plans under `docs/`.
- Constraint violations map to HTTP `409`. Zero-row results from write queries need a diagnostic to choose `404` vs `403`.
- Properties are flat primitives. No nested objects.

## Redis and Lua conventions

- Scripts live in `src/limiter/lua/`, loaded with `SCRIPT LOAD`, called with `EVALSHA`, with `NOSCRIPT` handled by reloading.
- Every script has a header comment documenting KEYS, ARGV, and the return shape.
- Changing a Lua script requires: a unit test, the concurrency test, and a property test passing.
- Cache entries always have a TTL. Refresh locks always have a short expiry.

## Testing rules

- Write the failing test first, then the implementation.
- Integration tests use Testcontainers, never a shared local database.
- Required tests:
  - 100 concurrent follows of one pair give one edge and a count of 1.
  - Block removes edges both ways and fixes counters.
  - Pagination has no duplicates or gaps while new follows arrive.
  - Limiter allows exactly burst-N under concurrent load.
  - 200 concurrent cold PYMK requests cause one computation.
  - PYMK excludes self, already-followed, and blocked users.
- Do not weaken or delete a test to make it pass. If a test looks wrong, say so and explain.

## Evaluation and benchmarks

- Recommendation changes are judged by the offline eval in `test/eval` (hide 20% of edges, report recall@10 and precision@10), not by eyeballing.
- Benchmark results go in the README as measured numbers with the graph size and hardware. Do not state a performance claim you did not measure. Report results that favor Postgres too.

## Working agreement

- Use plan mode before changing the graph schema, the PYMK pipeline, Lua scripts, or the cache design. Show the plan and wait.
- Do not add dependencies without asking.
- One phase deliverable at a time, with tests.
- Write a short ADR in `docs/adr/` for each real design decision (context, decision, consequences).
- If a request conflicts with an invariant above, stop and flag it instead of working around it.

## Current phase

Phase 3: PYMK v1 (staged pipeline, bounded generators, explanations), done (pending CI on push). Next: Phase 4, scale and data generation (power-law graph, bulk load, celebrity fixes). Update this line as phases complete.
