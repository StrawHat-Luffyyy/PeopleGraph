// PYMK generator 2: shared interests ("shares interests: rust, chess").
// Bounded (invariant 3): a user has at most 50 interests (enforced on write), and
// interests with more than $maxInterestFanout members are skipped (popularity cap;
// getDegree makes the member count cheap), plus LIMIT $limit.
// As in pymk-fof.cypher: aggregate per candidate and sort first, then run the
// self/followed/blocked checks lazily in front of the LIMIT, not once per path.
// pymk-filter.cypher is still the guarantee.
// Params:  $userId string, $maxInterestFanout int, $limit int
// Returns: up to $limit rows {id, sharedInterests, sampleInterests (<= 3 names, sorted)},
//          ordered by sharedInterests DESC, id ASC.
MATCH (me:User {id: $userId})-[:INTERESTED_IN]->(i:Interest)
WHERE COUNT { (i)<-[:INTERESTED_IN]-() } <= $maxInterestFanout
MATCH (i)<-[:INTERESTED_IN]-(c:User)
WHERE c <> me
WITH me, c, i
ORDER BY i.name
WITH me, c, count(i) AS sharedInterests, collect(i.name)[..3] AS sampleInterests
WITH me, c, c.id AS id, sharedInterests, sampleInterests
ORDER BY sharedInterests DESC, id ASC
WITH me, c, id, sharedInterests, sampleInterests
WHERE NOT EXISTS { (me)-[:FOLLOWS]->(c) }
  AND NOT EXISTS { (me)-[:BLOCKED]-(c) }
RETURN id, sharedInterests, sampleInterests
LIMIT $limit
