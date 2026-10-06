# Phase 3 PYMK query plans and measurements

**Setup:** Neo4j 5.26.31 Community in Docker (docker-compose), on Windows 11 with an i5-12450H and 16 GB of RAM. The cache was warm. `recommend()` times are the median of 7 runs of the whole pipeline (generate, filter, hydrate), measured from the Node driver. Db hits are deterministic. Wall times were taken with nothing else running; times taken while tests ran in parallel were discarded.

**Reproduce:** `npx tsx --env-file=.env scripts/measure-pymk.ts`. It builds the graph below, measures, and deletes everything it created.

## Measurement graph

The graph has 20,501 users and 150,550 FOLLOWS edges:

- **`me`** follows 500 "friends", plus 50 accounts in the candidate pool, so already-followed candidates really occur.
- **Each friend** follows 300 distinct accounts out of a 20,000-account pool.
- **Friends-of-friends** therefore walks 60,000 paths at the default first-hop cap of 200 friends, and 150,000 paths with no cap. Those paths reach about 14,000 distinct candidates.

## Finding: run exclusion checks per candidate, lazily, not per path

The first version of `pymk-fof.cypher` followed the design doc's shape: it checked self, already-followed and blocked inside the `WHERE` of the second-hop `MATCH`. The planner therefore ran both `Expand(Into)` exclusion checks on every path, 60,000 rows. Those two checks alone cost 742,677 + 742,224 db hits, about 1.48M of the query's 1.62M.

The final version:

1. aggregates per candidate first
2. sorts by `mutualCount DESC, id ASC`
3. only then applies the exclusions, in front of the `LIMIT`

The planner turns step 3 into a lazy partial sort, so the checks stop after 100 candidates survive. Here that was 101 rows checked, with 1 excluded.

| first-hop cap     | version             | friends-of-friends db hits | `recommend()` median ms | top result                                       |
| ----------------- | ------------------- | -------------------------: | ----------------------: | ------------------------------------------------ |
| 200 (default)     | per-path exclusions |                  1,621,594 |                   356.2 | followed by pymkm_f305, pymkm_f350 and 3 others  |
| 200 (default)     | **final**           |                **139,316** |               **138.2** | followed by pymkm_f305, pymkm_f350 and 3 others  |
| 500 (all friends) | per-path exclusions |                  4,042,405 |                   736.3 | followed by pymkm_f137, pymkm_f182 and 10 others |
| 500 (all friends) | **final**           |                **322,232** |               **159.4** | followed by pymkm_f137, pymkm_f182 and 10 others |

**Correctness:** all 100 rows were identical between the two versions at first-hop caps of 7, 200 and 500. The PYMK integration suite, including the required exclusion test, passes on the final version.

**What's left:**

- The second-hop expansion itself: about 60,000 db hits for the `Expand(All)` plus 60,000 for the `c:User` label check.
- The per-candidate aggregation.

The same lazy-exclusion pattern is applied to `pymk-interests` and `pymk-follows-you`. Their costs weren't measured at this scale, because this graph has no interests and `me` has no followers.

**Open question:** friends-of-friends alone ran at about 55 ms median, but `recommend()` took 138 ms. The other ~80 ms is spent somewhere in the other generators, the filter, hydration, or the three transaction round trips, and hasn't been broken down yet. Phase 5 (caching) and Phase 8 (metrics) are natural places to measure it per stage.

## First-hop cap

With the final query, lifting the cap from 200 to 500 friends raises friends-of-friends db hits by 2.3×, while end-to-end latency rose only 15% on this graph (138 → 159 ms). The cap matters more for users who follow thousands of accounts: work grows with the number of friends expanded. Whether 200 recent friends loses recall is a Phase 7 question for the offline eval.

## Plans (tiny graph, plan shape only)

`test/integration/plans.test.ts` guards these shapes:

- **Every PYMK query** starts from a unique-index seek and never uses a label or all-nodes scan.
- **Friends-of-friends** has a `Top ... LIMIT $maxFriends` on the first hop.
- **The filter** checks follows and blocks with `Expand(Into)` only.

### pymk-user (total dbHits 3)

```
ProduceResults@neo4j followerCount | rows=1 dbHits=0
  Projection@neo4j me.followerCount AS followerCount | rows=1 dbHits=1
    NodeUniqueIndexSeek@neo4j UNIQUE me:User(id) WHERE id = $userId | rows=1 dbHits=2
```

### pymk-fof (total dbHits 26)

```
ProduceResults@neo4j id, mutualCount, sampleMutuals | rows=1 dbHits=0
  Limit@neo4j $limit | rows=1 dbHits=0
    Apply@neo4j | rows=1 dbHits=0
      Sort@neo4j mutualCount DESC, id ASC | rows=1 dbHits=0
        Projection@neo4j c.id AS id | rows=1 dbHits=1
          Projection@neo4j anon_29[..$autoint_0] AS sampleMutuals | rows=1 dbHits=0
            EagerAggregation@neo4j me, c, collect(cache[f.handle]) AS anon_29, count(f) AS mutualCount | rows=1 dbHits=0
              Sort@neo4j `f.handle` ASC | rows=1 dbHits=0
                Projection@neo4j cache[f.handle] AS `f.handle` | rows=1 dbHits=1
                  Filter@neo4j NOT c = me AND c:User | rows=1 dbHits=1
                    Expand(All)@neo4j (f)-[anon_0:FOLLOWS]->(c) | rows=1 dbHits=4
                      Filter@neo4j f.followingCount <= $maxFanout | rows=1 dbHits=1
                        Unwind@neo4j friends AS f | rows=1 dbHits=0
                          Apply@neo4j | rows=1 dbHits=0
                            NodeUniqueIndexSeek@neo4j UNIQUE me:User(id) WHERE id = $userId | rows=1 dbHits=2
                            EagerAggregation@neo4j collect(f) AS friends | rows=1 dbHits=0
                              Top@neo4j `r.since` DESC LIMIT $maxFriends | rows=1 dbHits=0
                                Projection@neo4j r.since AS `r.since` | rows=1 dbHits=1
                                  Filter@neo4j f:User | rows=1 dbHits=1
                                    Expand(All)@neo4j (me)-[r:FOLLOWS]->(f) | rows=1 dbHits=2
                                      Argument@neo4j me | rows=1 dbHits=0
      AntiSemiApply@neo4j | rows=1 dbHits=0
        AntiSemiApply@neo4j | rows=1 dbHits=0
          Argument@neo4j id, mutualCount, me, sampleMutuals, c | rows=1 dbHits=0
          Expand(Into)@neo4j (me)-[anon_2:BLOCKED]-(c) | rows=0 dbHits=6
            Argument@neo4j me, c | rows=1 dbHits=0
        Expand(Into)@neo4j (me)-[anon_1:FOLLOWS]->(c) | rows=0 dbHits=6
          Argument@neo4j me, c | rows=1 dbHits=0
```

### pymk-interests (total dbHits 15)

```
ProduceResults@neo4j id, sharedInterests, sampleInterests | rows=0 dbHits=0
  Limit@neo4j $limit | rows=0 dbHits=0
    Apply@neo4j | rows=0 dbHits=0
      Sort@neo4j sharedInterests DESC, id ASC | rows=0 dbHits=0
        Projection@neo4j c.id AS id | rows=0 dbHits=0
          Projection@neo4j anon_6[..$autoint_0] AS sampleInterests | rows=0 dbHits=0
            EagerAggregation@neo4j me, c, collect(cache[i.name]) AS anon_6, count(i) AS sharedInterests | rows=0 dbHits=0
              Sort@neo4j `i.name` ASC | rows=0 dbHits=0
                Projection@neo4j cache[i.name] AS `i.name` | rows=0 dbHits=0
                  Filter@neo4j NOT c = me AND c:User | rows=0 dbHits=0
                    Expand(All)@neo4j (i)<-[anon_3:INTERESTED_IN]-(c) | rows=2 dbHits=4
                      Filter@neo4j getDegree((i)<-[:INTERESTED_IN]-()) <= $maxInterestFanout AND i:Interest | rows=2 dbHits=4
                        Expand(All)@neo4j (me)-[anon_0:INTERESTED_IN]->(i) | rows=2 dbHits=5
                          NodeUniqueIndexSeek@neo4j UNIQUE me:User(id) WHERE id = $userId | rows=1 dbHits=2
      AntiSemiApply@neo4j | rows=0 dbHits=0
        AntiSemiApply@neo4j | rows=0 dbHits=0
          Argument@neo4j sampleInterests, me, c, id, sharedInterests | rows=0 dbHits=0
          Expand(Into)@neo4j (me)-[anon_5:BLOCKED]-(c) | rows=0 dbHits=0
            Argument@neo4j me, c | rows=0 dbHits=0
        Expand(Into)@neo4j (me)-[anon_4:FOLLOWS]->(c) | rows=0 dbHits=0
          Argument@neo4j me, c | rows=0 dbHits=0
```

### pymk-follows-you (total dbHits 27)

```
ProduceResults@neo4j id | rows=1 dbHits=0
  Limit@neo4j $limit | rows=1 dbHits=0
    Apply@neo4j | rows=1 dbHits=0
      Sort@neo4j since DESC, id ASC | rows=2 dbHits=0
        Projection@neo4j r.since AS since, c.id AS id | rows=2 dbHits=4
          Filter@neo4j c:User | rows=2 dbHits=2
            Expand(All)@neo4j (me)<-[r:FOLLOWS]-(c) | rows=2 dbHits=4
              NodeUniqueIndexSeek@neo4j UNIQUE me:User(id) WHERE id = $userId | rows=1 dbHits=2
      AntiSemiApply@neo4j | rows=1 dbHits=0
        AntiSemiApply@neo4j | rows=2 dbHits=0
          Argument@neo4j me, c, id, since | rows=2 dbHits=0
          Expand(Into)@neo4j (me)-[anon_1:BLOCKED]-(c) | rows=0 dbHits=9
            Argument@neo4j me, c | rows=2 dbHits=0
        Expand(Into)@neo4j (me)-[anon_0:FOLLOWS]->(c) | rows=0 dbHits=6
          Argument@neo4j me, c | rows=2 dbHits=0
```

### pymk-filter (total dbHits 22)

```
ProduceResults@neo4j id | rows=1 dbHits=0
  Projection@neo4j cache[c.id] AS id | rows=1 dbHits=0
    Filter@neo4j NOT c = me | rows=1 dbHits=0
      Apply@neo4j | rows=1 dbHits=0
        Unwind@neo4j $ids AS candidateId | rows=2 dbHits=0
          NodeUniqueIndexSeek@neo4j UNIQUE me:User(id) WHERE id = $userId | rows=1 dbHits=2
        AntiSemiApply@neo4j | rows=1 dbHits=0
          AntiSemiApply@neo4j | rows=1 dbHits=0
            NodeUniqueIndexSeek@neo4j UNIQUE c:User(id) WHERE id = candidateId, cache[c.id] | rows=2 dbHits=4
            Expand(Into)@neo4j (me)-[anon_0:FOLLOWS]->(c) | rows=0 dbHits=10
              Argument@neo4j me, c | rows=2 dbHits=0
          Expand(Into)@neo4j (me)-[anon_1:BLOCKED]-(c) | rows=0 dbHits=6
            Argument@neo4j me, c | rows=1 dbHits=0
```

### pymk-hydrate (total dbHits 12)

```
ProduceResults@neo4j id, handle, followerCount | rows=3 dbHits=0
  Projection@neo4j cache[u.id] AS id, cache[u.handle] AS handle, cache[u.followerCount] AS followerCount | rows=3 dbHits=0
    CacheProperties@neo4j cache[u.handle], cache[u.followerCount] | rows=3 dbHits=6
      Apply@neo4j | rows=3 dbHits=0
        Unwind@neo4j $ids AS userId | rows=3 dbHits=0
        NodeUniqueIndexSeek@neo4j UNIQUE u:User(id) WHERE id = userId, cache[u.id] | rows=3 dbHits=6
```
