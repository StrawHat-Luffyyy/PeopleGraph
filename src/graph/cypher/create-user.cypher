// Creates a user, or matches the existing one with this id (idempotent).
// A handle owned by another id fails the user_handle constraint (mapped to 409).
// Params:  $id, $handle, $name  strings, already validated
// Returns: one row {id, handle, followerCount, followingCount, created}
MERGE (u:User {id: $id})
  ON CREATE SET u.handle = $handle,
                u.name = $name,
                u.followerCount = 0,
                u.followingCount = 0,
                u.createdAt = datetime(),
                u._created = true
WITH u, coalesce(u._created, false) AS created
REMOVE u._created
RETURN u.id AS id,
       u.handle AS handle,
       u.followerCount AS followerCount,
       u.followingCount AS followingCount,
       created
