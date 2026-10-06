// PYMK generator 1: friends of friends ("followed by ana, raj and 5 others").
// Bounded (invariant 3) three ways:
//   - only my $maxFriends most recent follows are expanded (first-hop cap; the design
//     doc's version had none, so following 50k accounts meant expanding all of them)
//   - friends who follow more than $maxFanout accounts are skipped (supernode guard,
//     read from the denormalized followingCount)
//   - LIMIT $limit on the output
// Order of work matters: aggregate per candidate, sort, and only then run the
// self/followed/blocked checks, lazily in front of the LIMIT. Checking per path instead
// cost 1.6M db hits vs 139k on a 150k-edge graph (docs/profiles/phase3-pymk.md).
// These exclusions keep excluded users from using up the LIMIT; the filter stage
// (pymk-filter.cypher) is still the guarantee.
// Params:  $userId string, $maxFriends int, $maxFanout int, $limit int
// Returns: up to $limit rows {id, mutualCount, sampleMutuals (<= 3 handles, sorted)},
//          ordered by mutualCount DESC, id ASC.
MATCH (me:User {id: $userId})
CALL (me) {
  MATCH (me)-[r:FOLLOWS]->(f:User)
  WITH f
  ORDER BY r.since DESC
  LIMIT $maxFriends
  RETURN collect(f) AS friends
}
UNWIND friends AS f
WITH me, f
WHERE f.followingCount <= $maxFanout
MATCH (f)-[:FOLLOWS]->(c:User)
WHERE c <> me
WITH me, c, f
ORDER BY f.handle
WITH me, c, count(f) AS mutualCount, collect(f.handle)[..3] AS sampleMutuals
WITH me, c, c.id AS id, mutualCount, sampleMutuals
ORDER BY mutualCount DESC, id ASC
WITH me, c, id, mutualCount, sampleMutuals
WHERE NOT EXISTS { (me)-[:FOLLOWS]->(c) }
  AND NOT EXISTS { (me)-[:BLOCKED]-(c) }
RETURN id, mutualCount, sampleMutuals
LIMIT $limit
