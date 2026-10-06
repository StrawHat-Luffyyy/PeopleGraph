// One page of the accounts a user follows, newest first, keyset-paginated (invariant 4).
// Mirror of followers.cypher; see it for the parameter contract and cost note.
// Params:  $userId, $cursorSince, $cursorId, $limit
// Returns: one row {items: [{id, handle, since}]} if the user exists; zero rows if not.
MATCH (u:User {id: $userId})
CALL (u) {
  MATCH (u)-[f:FOLLOWS]->(x:User)
  WHERE $cursorSince IS NULL
     OR f.since < datetime($cursorSince)
     OR (f.since = datetime($cursorSince) AND x.id < $cursorId)
  WITH x, f
  ORDER BY f.since DESC, x.id DESC
  LIMIT $limit
  RETURN collect({id: x.id, handle: x.handle, since: f.since}) AS items
}
RETURN items
