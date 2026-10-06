// PYMK pre-check: does the user exist, and how many followers do they have (the
// follows-you generator is skipped above PYMK_MAX_FOLLOWERS_SCAN).
// Params:  $userId  string
// Returns: one row {followerCount} if the user exists; zero rows otherwise.
MATCH (me:User {id: $userId})
RETURN me.followerCount AS followerCount
