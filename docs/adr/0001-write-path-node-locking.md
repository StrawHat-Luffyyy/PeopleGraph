# ADR-0001: Lock both users before reading edges in write paths

- **Status:** accepted
- **Date:** 2026-10-05

## Context

Follow, unfollow, block and replace-interests each read the graph and then write based on what they read. For example, follow reads "is there a block?" and then creates the edge.

Neo4j runs at read-committed isolation. A write takes an exclusive lock on the node or relationship it changes and holds it until commit, but a plain read takes no lock. So the design doc's single-statement queries (`docs/PEOPLEGRAPH_PLAN.md` §5) can act on stale reads when transactions run at the same time.

With those queries, integration tests reproduced three bugs. Each test failed until the fix below was applied, and fails again if `lock-users.cypher` drops its `SET`/`REMOVE`:

1. **Follow racing block.** The follow checks for a block before the block commits, then creates its FOLLOWS edge after the block's cleanup has run. The result is a follow edge between blocked users.
2. **Concurrent unfollows.** Both transactions match the same edge and both decrement the counters, which breaks invariant 2 (counter drift).
3. **Concurrent interest replacements.** Both delete the old set and both add their own, so the stored set is a mix of the two lists.

## Decision

Every write path that reads edges between users starts by write-locking those users. `lock-users.cypher` does `SET u._lock = true REMOVE u._lock` on each one. The operation's query runs after that, in the same `executeWrite` transaction.

- **Fixed lock order.** Ids are de-duplicated and sorted in TypeScript (`src/graph/locks.ts`), so every transaction takes locks in the same order. That rules out deadlocks caused by two transactions locking in opposite order. Any remaining transient errors are retried by the managed transaction.
- **Reads after the locks are safe.** The operation query's `MATCH` and `EXISTS` checks run after the locks are taken, so they see the committed result of any earlier writer on the same users.
- **404 diagnostic for free.** `lock-users` returns the ids it found, which gives the 404 diagnostic without an extra query. If follow returns zero rows after both users were found, the cause is a block, so the response is 403.
- **Nothing persists.** `_lock` is set and removed in one statement, so it is never committed.

## Consequences

- **Correctness is tested under concurrency.** The tests cover 100 concurrent follows, 100 concurrent unfollows, 50 + 50 opposite-direction follows, 20 rounds of follow racing block, and concurrent interest replacements. The counter-drift query returns zero rows after every test.
- **Writes on the same user run one at a time.** This costs little, because `followerCount + 1` already write-locks the target, so a celebrity's follows were serialized anyway. A hot account still limits write throughput. Phase 5's rate limiter and Phase 4's load tests will show whether that matters.
- **One extra round trip per write.** It runs inside the same transaction. It has not been measured yet; Phase 8's k6 runs will cover it.
- **The approach depends on Neo4j's locking.** It works because Neo4j holds write locks until commit and reads committed data after a lock is acquired. If we ever move to a store with snapshot isolation, this needs re-examining.
- **Avoiding APOC.** `apoc.lock.nodes` would do the same job but adds a plugin dependency. The `SET`/`REMOVE` trick needs nothing extra and runs on Neo4j Community and Aura.
