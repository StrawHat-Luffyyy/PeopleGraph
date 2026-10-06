# Phase 2 read-path query plans and celebrity measurements

**Setup:** Neo4j 5.26.31 Community in Docker (docker-compose), on Windows 11 with an i5-12450H and 16 GB of RAM. The cache was warm. Times are the median of 7 runs, measured from the Node driver and including the round trip. Db hits are deterministic: they were identical across three runs. Wall times moved by about 10% between idle runs, and nearly doubled while the integration tests were running on the same machine. Those runs were discarded.

**Reproduce:** `npx tsx --env-file=.env scripts/measure-celebrity-reads.ts`. It builds the graph below, measures, and deletes everything it created.

## Celebrity measurements

The graph was 120,003 users:

- **`star`:** 100,000 followers, each with a distinct `since`.
- **`big`:** follows 20,000 of those followers.
- **`small`:** follows 10 of them, 5 of which `big` also follows.

| query (page size 20, fetches 21)        | total db hits | median ms |
| --------------------------------------- | ------------: | --------: |
| followers page 1 (100k followers)       |       400,025 |     117.9 |
| followers deep page (~90% down)         |       220,027 |      64.2 |
| following page 1 (normal user)          |            10 |       9.0 |
| mutuals small(10) x big(20k)            |            72 |      10.7 |
| mutuals big(20k) x small(10)            |            72 |       7.7 |
| mutuals, forced to expand from big(20k) |       100,016 |      32.7 |

### Findings

1. **Every page of a celebrity's followers list costs O(followers).** The plan is a unique-index seek, then `Expand(All)` over every incoming FOLLOWS edge, filtered by the cursor, then a `Top N` sort. `LIMIT` bounds the output, not the work.
   - Page 1 at 100,000 followers costs 400,025 db hits.
   - A deep page is cheaper (220,027) because the cursor filter drops rows before the property reads, but it still expands all 100,000 edges.

   This fits the letter of invariant 3 (there is a `LIMIT`) but not its intent. The fix is Phase 4 work, as the design doc assigns it ("find your slowest query on a celebrity node and fix it"). Options to measure there:
   - a relationship range index on `FOLLOWS(since)`
   - per-user bucketing
   - capping how deep celebrity lists can be paged

2. **The denormalized `followingCount` pays for itself in mutuals.**
   - Expanding from the side that follows fewer accounts costs 72 db hits whichever order the two users are passed in.
   - Forcing the expansion from the side following 20,000 costs 100,016 db hits, about 1,400 times more.

   This is the first measured evidence for keeping the counters (the design doc asks for exactly this before Phase 4).

3. **Following a normal user is cheap** (10 db hits). The cost tracks the anchoring user's degree, not the size of the graph.

## Ties and timestamp resolution

On this setup `datetime()` resolves to the millisecond (`nanosecond = 852000000`). Even so, real follows of the same user rarely tie: Phase 1's lock serializes them, and each transaction takes longer than 1 ms. Ties come mainly from bulk loads that stamp a batch with one timestamp.

The `(since DESC, id DESC)` keyset handles ties. The tests prove it with mutation checks:

- **Dropping the `id` tie-breaker** fails the bulk-tie test and the "tie groups straddling page boundaries" test.
- **Using `<=` on the id comparison** fails 4 tests, including the required "no duplicates or gaps" test.

## Plans (tiny graph, plan shape only)

`test/integration/plans.test.ts` guards these shapes:

- **All three queries start from a unique-index seek** and never use a label or all-nodes scan.
- **Mutuals does exactly one `Expand(All)`**, from the user who follows fewer accounts. It then checks the other user with `Expand(Into)`.

### followers (total dbHits 13)

```
ProduceResults@neo4j items | rows=1 dbHits=0
  Apply@neo4j | rows=1 dbHits=0
    NodeUniqueIndexSeek@neo4j UNIQUE u:User(id) WHERE id = $userId | rows=1 dbHits=2
    EagerAggregation@neo4j collect({id: cache[x.id], handle: x.handle, since: cache[f.since]}) AS items | rows=1 dbHits=2
      Top@neo4j `f.since` DESC, `x.id` DESC LIMIT $limit | rows=2 dbHits=0
        Projection@neo4j cache[f.since] AS `f.since`, cache[x.id] AS `x.id` | rows=2 dbHits=4
          Filter@neo4j ($cursorSince IS NULL OR cache[f.since] < RuntimeConstant(datetime($cursorSince)) OR cache[f.since] = RuntimeConstant(datetime($cursorSince))) AND ($cursorSince IS NULL OR cache[f.since] < RuntimeConstant(datetime($cursorSince)) OR cache[x.id] < $cursorId) AND x:User | rows=2 dbHits=2
            Expand(All)@neo4j (u)<-[f:FOLLOWS]-(x) | rows=2 dbHits=3
              Argument@neo4j u | rows=1 dbHits=0
```

### following (total dbHits 10)

```
ProduceResults@neo4j items | rows=1 dbHits=0
  Apply@neo4j | rows=1 dbHits=0
    NodeUniqueIndexSeek@neo4j UNIQUE u:User(id) WHERE id = $userId | rows=1 dbHits=2
    EagerAggregation@neo4j collect({id: cache[x.id], handle: x.handle, since: cache[f.since]}) AS items | rows=1 dbHits=1
      Top@neo4j `f.since` DESC, `x.id` DESC LIMIT $limit | rows=1 dbHits=0
        Projection@neo4j cache[f.since] AS `f.since`, cache[x.id] AS `x.id` | rows=1 dbHits=2
          Filter@neo4j ($cursorSince IS NULL OR cache[f.since] < RuntimeConstant(datetime($cursorSince)) OR cache[f.since] = RuntimeConstant(datetime($cursorSince))) AND ($cursorSince IS NULL OR cache[f.since] < RuntimeConstant(datetime($cursorSince)) OR cache[x.id] < $cursorId) AND x:User | rows=1 dbHits=1
            Expand(All)@neo4j (u)-[f:FOLLOWS]->(x) | rows=1 dbHits=4
              Argument@neo4j u | rows=1 dbHits=0
```

### mutuals (total dbHits 16)

```
ProduceResults@neo4j items | rows=1 dbHits=0
  Apply@neo4j | rows=1 dbHits=0
    Projection@neo4j pair[$autoint_0] AS fewer, pair[$autoint_1] AS other | rows=1 dbHits=0
      Projection@neo4j CASE
  WHEN a.followingCount <= b.followingCount THEN [a, b]
  ELSE [b, a]
END AS pair | rows=1 dbHits=2
        CartesianProduct@neo4j | rows=1 dbHits=0
          NodeUniqueIndexSeek@neo4j UNIQUE a:User(id) WHERE id = $aId | rows=1 dbHits=2
          NodeUniqueIndexSeek@neo4j UNIQUE b:User(id) WHERE id = $bId | rows=1 dbHits=2
    EagerAggregation@neo4j collect({id: cache[m.id], handle: m.handle}) AS items | rows=1 dbHits=1
      Top@neo4j `m.id` ASC LIMIT $limit | rows=1 dbHits=0
        Projection@neo4j cache[m.id] AS `m.id` | rows=1 dbHits=1
          Filter@neo4j NOT m = other AND ($cursorId IS NULL OR cache[m.id] > $cursorId) AND m:User | rows=1 dbHits=1
            SemiApply@neo4j | rows=1 dbHits=0
              Expand(All)@neo4j (fewer)-[anon_0:FOLLOWS]->(m) | rows=1 dbHits=4
                Argument@neo4j fewer, other | rows=1 dbHits=0
              Expand(Into)@neo4j (other)-[anon_1:FOLLOWS]->(m) | rows=0 dbHits=3
                Argument@neo4j m, other | rows=1 dbHits=0
```
