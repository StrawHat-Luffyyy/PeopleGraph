// Deletes a FOLLOWS edge and decrements both counters (invariant 2).
// Run after lock-users on both ids.
// Plan: both users by unique-index seek, then the edge by Expand(Into) inside a
// CALL subquery where a and b are already-bound arguments. Measured at 20k followers:
// 11 db hits. The design doc's `MATCH (a {id})-[f]->(b {id})` let the cost planner seek
// one endpoint and Expand(All) over its edges (40,009 db hits for a celebrity target).
// Index hints and a WITH barrier did not prevent that on all statistics; the subquery
// did. Guarded by test/integration/plans.test.ts. See docs/profiles/phase1-writes.md.
// Counters drop by the number of edges deleted (at most 1 under the lock), not a constant.
// Params:  $followerId, $targetId  strings
// Returns: one row {removed: true} if an edge was deleted; zero rows otherwise.
MATCH (a:User {id: $followerId}), (b:User {id: $targetId})
CALL (a, b) {
  MATCH (a)-[f:FOLLOWS]->(b)
  DELETE f
  RETURN count(*) AS deleted
}
WITH a, b, deleted
WHERE deleted > 0
SET a.followingCount = a.followingCount - deleted,
    b.followerCount = b.followerCount - deleted
RETURN true AS removed
