// Finds users whose denormalized counters disagree with their real FOLLOWS degree.
// Must return zero rows after every mutating test (invariant 2).
// Scans all users: fine for tests and small graphs; batch or sample it before running
// it as a periodic job on a large graph (Phase 4).
// A missing counter counts as drift (coalesce to -1), so nulls cannot hide.
// Params:  $limit  integer
// Returns: up to $limit rows {id, storedFollowers, actualFollowers, storedFollowing, actualFollowing}
MATCH (u:User)
WITH u,
     COUNT { (u)<-[:FOLLOWS]-() } AS followers,
     COUNT { (u)-[:FOLLOWS]->() } AS following
WHERE coalesce(u.followerCount, -1) <> followers
   OR coalesce(u.followingCount, -1) <> following
RETURN u.id AS id,
       u.followerCount AS storedFollowers,
       followers AS actualFollowers,
       u.followingCount AS storedFollowing,
       following AS actualFollowing
LIMIT $limit
