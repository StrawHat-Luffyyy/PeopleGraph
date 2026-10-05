# PeopleGraph

Social graph service with "people you may know" recommendations, built on Neo4j and Redis.
See [docs/PEOPLEGRAPH_PLAN.md](docs/PEOPLEGRAPH_PLAN.md) for the design and phases.

## Status

Phase 1 (graph model and write paths) is complete: constraints, user creation, interests, follow,
unfollow and block, safe under concurrent writes (see [ADR-0001](docs/adr/0001-write-path-node-locking.md)).
No benchmark results yet. Numbers will be added here only once they are measured; query-level
measurements so far are in [docs/profiles/phase1-writes.md](docs/profiles/phase1-writes.md).

## Running locally

Requires Node 22+ and Docker.

```bash
npm ci
cp .env.example .env
docker compose up -d --wait
npm run dev
```

- `GET /healthz`: liveness, always `200`.
- `GET /readyz`: `200` when Neo4j and Redis both answer, `503` naming the one that didn't.

### Write API

The caller is identified by the `X-User-Id` header in development (JWT comes in Phase 8).

| Method | Path                                           | Result                                                                                                      |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/users` `{id, handle, name}`               | `201` created, `200` already exists (idempotent on id), `409` handle taken or id reused with another handle |
| PUT    | `/v1/users/:id/interests` `{interests: [...]}` | `200` with the normalized list; caller must be `:id` (`403` otherwise)                                      |
| POST   | `/v1/follow/:targetId`                         | `201` new, `200` already following, `400` self, `403` blocked either way, `404` unknown user                |
| DELETE | `/v1/follow/:targetId`                         | `204` always (idempotent)                                                                                   |
| POST   | `/v1/block/:targetId`                          | `201` new, `200` repeat; removes follows in both directions                                                 |

Errors are JSON `{error, message}`. A missing or malformed `X-User-Id` is `401`.

Neo4j Browser is at http://localhost:7474 (user `neo4j`, password from `.env`).

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
```

`test:integration` starts its own Neo4j and Redis with Testcontainers and never touches the
docker-compose databases. After every graph test it asserts the counter-drift query returns
zero rows.

To record query plans against the local docker-compose database (this executes writes, so
never point it at a shared database):

```bash
npx tsx --env-file=.env scripts/profile-queries.ts
```
