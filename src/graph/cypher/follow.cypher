// Creates a FOLLOWS edge and bumps both counters, only if the edge is new (invariant 2).
// Run after lock-users on both ids.
// Params:  $followerId, $targetId  strings, distinct, both known to exist
// Returns: one row {created}; zero rows means a block exists in either direction.
MATCH (a:User {id: $followerId}), (b:User {id: $targetId})
WHERE a <> b AND NOT EXISTS { (a)-[:BLOCKED]-(b) }
MERGE (a)-[f:FOLLOWS]->(b)
  ON CREATE SET f.since = datetime(),
                f._created = true,
                a.followingCount = a.followingCount + 1,
                b.followerCount = b.followerCount + 1
WITH f, coalesce(f._created, false) AS created
REMOVE f._created
RETURN created
