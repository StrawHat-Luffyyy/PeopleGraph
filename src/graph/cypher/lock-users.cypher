// Takes exclusive write locks on the given users, held until the transaction ends.
// Run this FIRST in every write that reads edges between users and then changes them
// (follow, unfollow, block, replace interests), so racing writes on the same users
// serialize and see each other's committed result. See docs/adr/0001.
// The set+remove of _lock writes nothing that survives the statement.
// Params: $ids  string[]  distinct, sorted by the caller so every transaction locks in
//                         the same order (no lock-ordering deadlocks)
// Returns: one row {id} per user that exists; missing ids are absent.
UNWIND $ids AS id
MATCH (u:User {id: id})
SET u._lock = true
REMOVE u._lock
RETURN u.id AS id
