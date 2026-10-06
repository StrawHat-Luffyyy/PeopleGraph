// PYMK generator 3: people who follow me that I don't follow back ("follows you").
// The repository only runs this when my followerCount <= PYMK_MAX_FOLLOWERS_SCAN:
// ordering by recency reads every follower, which is unbounded for a celebrity.
// Sort first, then run the followed/blocked checks lazily in front of the LIMIT.
// pymk-filter.cypher is still the guarantee.
// Params:  $userId string, $limit int
// Returns: up to $limit rows {id}, most recent followers first.
MATCH (me:User {id: $userId})<-[r:FOLLOWS]-(c:User)
WITH me, c, c.id AS id, r.since AS since
ORDER BY since DESC, id ASC
WITH me, c, id
WHERE NOT EXISTS { (me)-[:FOLLOWS]->(c) }
  AND NOT EXISTS { (me)-[:BLOCKED]-(c) }
RETURN id
LIMIT $limit
