// One page of mutual connections: accounts that both users follow, ordered by id,
// keyset-paginated (invariant 4).
// The relation is symmetric, so we expand from whichever user follows fewer accounts
// (denormalized followingCount) and check the other with Expand(Into). Without this,
// mutuals with a user who follows 50k accounts could expand all 50k.
// Params:  $aId, $bId  strings, distinct
//          $cursorId    string or null (first page): last id of the previous page
//          $limit       integer; the caller asks for page size + 1 to detect more
// Returns: one row {items: [{id, handle}]} if both users exist; zero rows otherwise.
MATCH (a:User {id: $aId}), (b:User {id: $bId})
WITH CASE WHEN a.followingCount <= b.followingCount THEN [a, b] ELSE [b, a] END AS pair
WITH pair[0] AS fewer, pair[1] AS other
CALL (fewer, other) {
  MATCH (fewer)-[:FOLLOWS]->(m:User)
  WHERE ($cursorId IS NULL OR m.id > $cursorId)
    AND m <> other
    AND EXISTS { (other)-[:FOLLOWS]->(m) }
  WITH m
  ORDER BY m.id
  LIMIT $limit
  RETURN collect({id: m.id, handle: m.handle}) AS items
}
RETURN items
