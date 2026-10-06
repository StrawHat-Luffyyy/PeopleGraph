// Constraints applied at startup. Idempotent (IF NOT EXISTS). One statement per ';'.
// Each uniqueness constraint also creates the backing index used for seeks.
CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT user_handle IF NOT EXISTS FOR (u:User) REQUIRE u.handle IS UNIQUE;
CREATE CONSTRAINT interest_name IF NOT EXISTS FOR (i:Interest) REQUIRE i.name IS UNIQUE;
