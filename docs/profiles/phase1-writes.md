# Phase 1 write-path query plans

**How these were produced:** `npx tsx --env-file=.env scripts/profile-queries.ts`, run against the docker-compose database. That is Neo4j 5.26.31 Community, in Docker on Windows 11, on an i5-12450H with 16 GB of RAM. The graph was tiny: two profiling users plus a few leftovers from manual testing. So the db-hit numbers below show **plan shape**, not cost at scale.

## What to check in each plan

- **Every per-user query starts from `NodeUniqueIndexSeek(Locking)`** on `User(id)`. That index comes from the `user_id` constraint.
- **Pair queries find the edge with `Expand(Into)`**, after seeking both endpoints. This applies to follow, unfollow and block.
- **The only label scan is `counter-drift`.** That is expected: it checks every user. It reads degrees with the cheap `getDegree` instead of expanding edges. Before running it as a periodic job on a large graph, batch or sample it (Phase 4).
- **`test/integration/plans.test.ts` guards this.** It fails if a pair query plans `Expand(All)`, `NodeByLabelScan` or `AllNodesScan`.

## Notable finding: the design doc's unfollow query expands a celebrity's whole fan-in

`MATCH (a:User {id: $followerId})-[f:FOLLOWS]->(b:User {id: $targetId})` let the cost planner seek only one endpoint and run `Expand(All)` over all of its FOLLOWS edges. On a tiny graph that looks cheap. For an account with many followers, or one that follows many people, it isn't.

Measured with one fan unfollowing a celebrity that has 20,000 followers, on the same setup:

| unfollow variant                                                        | total db hits |
| ----------------------------------------------------------------------- | ------------: |
| design doc: single pattern `MATCH`                                      |        40,009 |
| final: seek both, then `CALL (a, b) { MATCH (a)-[f:FOLLOWS]->(b) ... }` |            11 |

**Things that did not fix it:**

- `USING INDEX` hints on both endpoints. With the statistics of an empty database, the planner still ran `Expand(All)` from one side and joined.
- A `WITH a, b` barrier. The planner merged it away.

**What did fix it:** the `CALL (a, b)` subquery. It binds both users before the pattern, so the planner has to connect two already-bound nodes. I checked the plan on an empty database, on a populated one, and on a 2,000-follower celebrity pair. All of them planned `Expand(Into)`.

## Plans (final queries)

### create-user (total dbHits 8)

```
ProduceResults@neo4j id, handle, followerCount, followingCount, created | rows=1 dbHits=0
  Projection@neo4j cache[u.id] AS id, cache[u.followingCount] AS followingCount, cache[u.handle] AS handle, cache[u.followerCount] AS followerCount | rows=1 dbHits=0
    CacheProperties@neo4j cache[u.id], cache[u.followingCount], cache[u.handle], cache[u.followerCount] | rows=1 dbHits=0
      SetProperty@neo4j u._created = NULL | rows=1 dbHits=1
        Eager@neo4j read/set conflict for property: _created (Operator: 3 vs 5) | rows=1 dbHits=0
          Projection@neo4j coalesce(u._created, false) AS created | rows=1 dbHits=1
            Eager@neo4j read/set conflict for property: _created (Operator: 7 vs 5), read/set conflict for property: followerCount (Operator: 7 vs 1), read/set conflict for property: followingCount (Operator: 7 vs 1), read/set conflict for property: handle (Operator: 7 vs 1) | rows=1 dbHits=0
              Merge@neo4j CREATE (u:User {id: $id}), ON CREATE SET u.handle = $handle, u.name = $name, u.followerCount = $autoint_0, u.followingCount = $autoint_1, u.createdAt = datetime(), u._created = true | rows=1 dbHits=5
                NodeUniqueIndexSeek(Locking)@neo4j UNIQUE u:User(id) WHERE id = $id, cache[u.id] | rows=0 dbHits=1
```

### create-user (total dbHits 8)

```
ProduceResults@neo4j id, handle, followerCount, followingCount, created | rows=1 dbHits=0
  Projection@neo4j cache[u.id] AS id, cache[u.followingCount] AS followingCount, cache[u.handle] AS handle, cache[u.followerCount] AS followerCount | rows=1 dbHits=0
    CacheProperties@neo4j cache[u.id], cache[u.followingCount], cache[u.handle], cache[u.followerCount] | rows=1 dbHits=0
      SetProperty@neo4j u._created = NULL | rows=1 dbHits=1
        Eager@neo4j read/set conflict for property: _created (Operator: 3 vs 5) | rows=1 dbHits=0
          Projection@neo4j coalesce(u._created, false) AS created | rows=1 dbHits=1
            Eager@neo4j read/set conflict for property: _created (Operator: 7 vs 5), read/set conflict for property: followerCount (Operator: 7 vs 1), read/set conflict for property: followingCount (Operator: 7 vs 1), read/set conflict for property: handle (Operator: 7 vs 1) | rows=1 dbHits=0
              Merge@neo4j CREATE (u:User {id: $id}), ON CREATE SET u.handle = $handle, u.name = $name, u.followerCount = $autoint_0, u.followingCount = $autoint_1, u.createdAt = datetime(), u._created = true | rows=1 dbHits=5
                NodeUniqueIndexSeek(Locking)@neo4j UNIQUE u:User(id) WHERE id = $id, cache[u.id] | rows=0 dbHits=1
```

### lock-users (total dbHits 8)

```
ProduceResults@neo4j id | rows=2 dbHits=0
  Projection@neo4j cache[u.id] AS id | rows=2 dbHits=2
    SetProperty@neo4j u._lock = NULL | rows=2 dbHits=2
      SetProperty@neo4j u._lock = true | rows=2 dbHits=2
        Apply@neo4j | rows=2 dbHits=0
          Unwind@neo4j $ids AS id | rows=2 dbHits=0
          NodeUniqueIndexSeek(Locking)@neo4j UNIQUE u:User(id) WHERE id = id, cache[u.id] | rows=2 dbHits=2
```

### replace-interests (total dbHits 14)

```
ProduceResults@neo4j name | rows=2 dbHits=0
  Projection@neo4j cache[i.name] AS name | rows=2 dbHits=0
    Apply@neo4j | rows=2 dbHits=0
      Apply@neo4j | rows=2 dbHits=0
        Unwind@neo4j $interests AS interestName | rows=2 dbHits=0
          Eager@neo4j read/delete conflict for variable: anon_1 (Operator: 12 vs 4) | rows=1 dbHits=0
            Distinct@neo4j u | rows=1 dbHits=0
              Delete@neo4j old | rows=1 dbHits=0
                Eager@neo4j read/delete conflict for variable: old (Operator: 12 vs 14), read/set conflict for label: Interest (Operator: 7 vs 14), read/set conflict for relationship type: INTERESTED_IN (Operator: 3 vs 14) | rows=1 dbHits=0
                  OptionalExpand(All)@neo4j (u)-[old:INTERESTED_IN]->(anon_0) WHERE anon_0:Interest | rows=1 dbHits=1
                    NodeUniqueIndexSeek(Locking)@neo4j UNIQUE u:User(id) WHERE id = $userId | rows=1 dbHits=1
        Merge@neo4j CREATE (i:Interest {name: interestName}) | rows=2 dbHits=0
          NodeUniqueIndexSeek(Locking)@neo4j UNIQUE i:Interest(name) WHERE name = interestName, cache[i.name] | rows=2 dbHits=2
      LockingMerge@neo4j CREATE (u)-[anon_1:INTERESTED_IN]->(i), LOCK(u, i) | rows=2 dbHits=2
        Expand(Into)@neo4j (u)-[anon_1:INTERESTED_IN]->(i) | rows=0 dbHits=8
          Argument@neo4j u, i | rows=4 dbHits=0
```

### follow (total dbHits 17)

```
ProduceResults@neo4j created | rows=1 dbHits=0
  SetProperty@neo4j f._created = NULL | rows=1 dbHits=1
    Eager@neo4j read/set conflict for property: _created (Operator: 1 vs 3) | rows=1 dbHits=0
      Projection@neo4j coalesce(f._created, false) AS created | rows=1 dbHits=1
        Eager@neo4j read/set conflict for property: _created (Operator: 6 vs 3) | rows=1 dbHits=0
          Apply@neo4j | rows=1 dbHits=0
            AntiSemiApply@neo4j | rows=1 dbHits=0
              Filter@neo4j NOT a = b | rows=1 dbHits=0
                CartesianProduct@neo4j | rows=1 dbHits=0
                  NodeUniqueIndexSeek(Locking)@neo4j UNIQUE a:User(id) WHERE id = $followerId | rows=1 dbHits=1
                  NodeUniqueIndexSeek(Locking)@neo4j UNIQUE b:User(id) WHERE id = $targetId | rows=1 dbHits=1
              Expand(Into)@neo4j (a)-[anon_0:BLOCKED]-(b) | rows=0 dbHits=2
                Argument@neo4j a, b | rows=1 dbHits=0
            LockingMerge@neo4j CREATE (a)-[f:FOLLOWS]->(b), ON CREATE SET f.since = datetime(), f._created = true, SET a.followingCount = a.followingCount + $autoint_0, SET b.followerCount = b.followerCount + $autoint_1, LOCK(a, b) | rows=1 dbHits=7
              Expand(Into)@neo4j (a)-[f:FOLLOWS]->(b) | rows=0 dbHits=4
                Argument@neo4j a, b | rows=2 dbHits=0
```

### unfollow (total dbHits 10)

```
ProduceResults@neo4j removed | rows=1 dbHits=0
  Projection@neo4j true AS removed | rows=1 dbHits=0
    SetProperty@neo4j b.followerCount = b.followerCount - deleted | rows=1 dbHits=2
      SetProperty@neo4j a.followingCount = a.followingCount - deleted | rows=1 dbHits=2
        Filter@neo4j deleted > $autoint_0 | rows=1 dbHits=0
          Apply@neo4j | rows=1 dbHits=0
            CartesianProduct@neo4j | rows=1 dbHits=0
              NodeUniqueIndexSeek(Locking)@neo4j UNIQUE a:User(id) WHERE id = $followerId | rows=1 dbHits=1
              NodeUniqueIndexSeek(Locking)@neo4j UNIQUE b:User(id) WHERE id = $targetId | rows=1 dbHits=1
            EagerAggregation@neo4j count(*) AS deleted | rows=1 dbHits=0
              Delete@neo4j f | rows=1 dbHits=1
                Eager@neo4j read/delete conflict for variable: f (Operator: 7 vs 9) | rows=1 dbHits=0
                  Expand(Into)@neo4j (a)-[f:FOLLOWS]->(b) | rows=1 dbHits=3
                    Argument@neo4j a, b | rows=1 dbHits=0
```

### block (total dbHits 17)

```
ProduceResults@neo4j created | rows=1 dbHits=0
  Foreach@neo4j _ IN CASE
  WHEN f2 IS NULL THEN []
  ELSE [1]
END, SET b.followingCount = b.followingCount - 1, SET a.followerCount = a.followerCount - 1, DELETE f2 | rows=1 dbHits=0
    Eager@neo4j read/delete conflict for variable: _ (Operator: 1 vs 3), read/delete conflict for variable: a (Operator: 3 vs 1, and 1 more conflicting operators), read/delete conflict for variable: b (Operator: 1 vs 3, and 1 more conflicting operators), read/delete conflict for variable: f1 (Operator: 1 vs 3), read/delete conflict for variable: f2 (Operator: 3 vs 1), read/set conflict for property: followerCount (Operator: 1 vs 3, and 1 more conflicting operators), read/set conflict for property: followingCount (Operator: 3 vs 1, and 1 more conflicting operators) | rows=1 dbHits=0
      Foreach@neo4j _ IN CASE
  WHEN f1 IS NULL THEN []
  ELSE [1]
END, SET a.followingCount = a.followingCount - 1, SET b.followerCount = b.followerCount - 1, DELETE f1 | rows=1 dbHits=0
        Eager@neo4j read/delete conflict for variable: a (Operator: 3 vs 7, and 4 more conflicting operators), read/delete conflict for variable: b (Operator: 3 vs 7, and 4 more conflicting operators), read/delete conflict for variable: bl (Operator: 1 vs 15, and 2 more conflicting operators), read/delete conflict for variable: f1 (Operator: 3 vs 6, and 1 more conflicting operators), read/delete conflict for variable: f2 (Operator: 1 vs 7, and 1 more conflicting operators) | rows=1 dbHits=0
          Apply@neo4j | rows=1 dbHits=0
            SetProperty@neo4j bl._created = NULL | rows=1 dbHits=1
              Eager@neo4j read/delete conflict for variable: a (Operator: 3 vs 14, and 2 more conflicting operators), read/delete conflict for variable: b (Operator: 3 vs 14, and 2 more conflicting operators), read/delete conflict for variable: bl (Operator: 3 vs 14, and 2 more conflicting operators), read/set conflict for property: _created (Operator: 9 vs 11) | rows=1 dbHits=0
                Projection@neo4j coalesce(bl._created, false) AS created | rows=1 dbHits=1
                  Eager@neo4j read/delete conflict for variable: a (Operator: 1 vs 14, and 1 more conflicting operators), read/delete conflict for variable: b (Operator: 1 vs 19, and 3 more conflicting operators), read/delete conflict for variable: bl (Operator: 3 vs 15, and 1 more conflicting operators), read/set conflict for property: _created (Operator: 14 vs 11) | rows=1 dbHits=0
                    Apply@neo4j | rows=1 dbHits=0
                      Filter@neo4j NOT a = b | rows=1 dbHits=0
                        CartesianProduct@neo4j | rows=1 dbHits=0
                          NodeUniqueIndexSeek(Locking)@neo4j UNIQUE a:User(id) WHERE id = $blockerId | rows=1 dbHits=1
                          NodeUniqueIndexSeek(Locking)@neo4j UNIQUE b:User(id) WHERE id = $targetId | rows=1 dbHits=1
                      LockingMerge@neo4j CREATE (a)-[bl:BLOCKED]->(b), ON CREATE SET bl.since = datetime(), bl._created = true, LOCK(a, b) | rows=1 dbHits=3
                        Expand(Into)@neo4j (a)-[bl:BLOCKED]->(b) | rows=0 dbHits=4
                          Argument@neo4j a, b | rows=2 dbHits=0
            OptionalExpand(Into)@neo4j (a)-[f1:FOLLOWS]->(b) | rows=1 dbHits=2
              OptionalExpand(Into)@neo4j (b)-[f2:FOLLOWS]->(a) | rows=1 dbHits=4
                Argument@neo4j a, b, created | rows=1 dbHits=0
```

### counter-drift (total dbHits 21)

```
ProduceResults@neo4j id, storedFollowers, actualFollowers, storedFollowing, actualFollowing | rows=0 dbHits=0
  Projection@neo4j u.id AS id, cache[u.followerCount] AS storedFollowers, cache[u.followingCount] AS storedFollowing, following AS actualFollowing, followers AS actualFollowers | rows=0 dbHits=0
    Limit@neo4j $limit | rows=0 dbHits=0
      Filter@neo4j (NOT coalesce(cache[u.followerCount], $autoint_0) = followers OR NOT coalesce(cache[u.followingCount], $autoint_1) = following) | rows=0 dbHits=8
        Projection@neo4j getDegree((u)<-[:FOLLOWS]-()) AS followers, getDegree((u)-[:FOLLOWS]->()) AS following | rows=4 dbHits=8
          NodeByLabelScan@neo4j u:User | rows=4 dbHits=5
```
