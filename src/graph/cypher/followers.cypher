// One page of a user's followers, newest first, keyset-paginated (invariant 4).
// Params:  $userId       string
//          $cursorSince  ISO datetime string or null (first page)
//          $cursorId     string or null; tie-breaker for equal `since`
//          $limit        integer; the caller asks for page size + 1 to detect more
// Returns: one row {items: [{id, handle, since}]} if the user exists; zero rows if not.
// Cost: sorts all of the user's followers on every page (LIMIT bounds output, not the
// expansion). Measured in docs/profiles/phase2-reads.md; celebrity fix is Phase 4.
MATCH (u:User {id: $userId})
CALL (u) {
  MATCH (u)<-[f:FOLLOWS]-(x:User)
  WHERE $cursorSince IS NULL
     OR f.since < datetime($cursorSince)
     OR (f.since = datetime($cursorSince) AND x.id < $cursorId)
  WITH x, f
  ORDER BY f.since DESC, x.id DESC
  LIMIT $limit
  RETURN collect({id: x.id, handle: x.handle, since: f.since}) AS items
}
RETURN items
