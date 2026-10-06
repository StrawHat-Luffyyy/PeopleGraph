// PYMK filter stage: the exclusion guarantee. Of the given candidate ids, returns only
// those that may be recommended now: an existing user, not me, not already followed,
// and no block in either direction. Runs at serve time against the live graph, so it
// stays correct even when candidates come from a cache (Phase 5).
// Params:  $userId string, $ids string[] (at most 2 x the requested limit)
// Returns: one row {id} per allowed candidate. Zero rows if the user does not exist.
MATCH (me:User {id: $userId})
UNWIND $ids AS candidateId
MATCH (c:User {id: candidateId})
WHERE c <> me
  AND NOT EXISTS { (me)-[:FOLLOWS]->(c) }
  AND NOT EXISTS { (me)-[:BLOCKED]-(c) }
RETURN c.id AS id
