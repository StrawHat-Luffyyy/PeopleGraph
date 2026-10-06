// Replaces a user's interests. Run after lock-users on the same user.
// Params:  $userId  string
//          $interests  string[]  normalized and capped in TypeScript (max 50)
// Returns: one row {name} per stored interest; zero rows for an empty list.
MATCH (u:User {id: $userId})
OPTIONAL MATCH (u)-[old:INTERESTED_IN]->(:Interest)
DELETE old
WITH DISTINCT u
UNWIND $interests AS interestName
MERGE (i:Interest {name: interestName})
MERGE (u)-[:INTERESTED_IN]->(i)
RETURN i.name AS name
