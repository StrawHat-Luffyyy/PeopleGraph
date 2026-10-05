// Creates a BLOCKED edge (idempotent) and removes FOLLOWS edges in both directions,
// fixing all four counters in the same transaction (invariant 2).
// Run after lock-users on both ids.
// Params:  $blockerId, $targetId  strings, distinct, both known to exist
// Returns: one row {created}: true if the BLOCKED edge is new.
MATCH (a:User {id: $blockerId}), (b:User {id: $targetId})
WHERE a <> b
MERGE (a)-[bl:BLOCKED]->(b)
  ON CREATE SET bl.since = datetime(), bl._created = true
WITH a, b, bl, coalesce(bl._created, false) AS created
REMOVE bl._created
WITH a, b, created
OPTIONAL MATCH (a)-[f1:FOLLOWS]->(b)
OPTIONAL MATCH (b)-[f2:FOLLOWS]->(a)
FOREACH (_ IN CASE WHEN f1 IS NULL THEN [] ELSE [1] END |
  SET a.followingCount = a.followingCount - 1,
      b.followerCount = b.followerCount - 1
  DELETE f1)
FOREACH (_ IN CASE WHEN f2 IS NULL THEN [] ELSE [1] END |
  SET b.followingCount = b.followingCount - 1,
      a.followerCount = a.followerCount - 1
  DELETE f2)
RETURN created
