// PYMK hydrate stage: public profile fields for the final recommendations. Ids are
// seeked one by one through the unique index. Names are never returned.
// Params:  $ids string[] (at most the requested limit)
// Returns: one row {id, handle, followerCount} per existing user, in no particular order.
UNWIND $ids AS userId
MATCH (u:User {id: userId})
RETURN u.id AS id, u.handle AS handle, u.followerCount AS followerCount
