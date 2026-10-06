# PeopleGraph

Social graph service with "people you may know" recommendations, built on Neo4j and Redis.
See [docs/PEOPLEGRAPH_PLAN.md](docs/PEOPLEGRAPH_PLAN.md) for the design and phases.

## Status

Phases 1 and 2 are complete.

- **Write paths:** constraints, user creation, interests, follow, unfollow and block, safe under concurrent writes (see [ADR-0001](docs/adr/0001-write-path-node-locking.md)).
- **Read paths:** followers, following and mutuals with keyset pagination.

There are no benchmark results yet. Numbers will be added here only once they are measured. Query-level measurements so far are in [docs/profiles/](docs/profiles/).

**Known limit:** every page of a user's followers or following list sorts all of that user's edges. At 100,000 followers that is about 400,000 db hits per page (see [phase2-reads.md](docs/profiles/phase2-reads.md)). Fixing it is Phase 4 work.

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

### Read API

All list endpoints need `X-User-Id`. They take `?limit=` (1-100, default 20) and `?cursor=`, and return `{items, nextCursor}`. To get the next page, pass `nextCursor` back as `cursor`. It is `null` on the last page.

| Method | Path                             | Order               | Items                 |
| ------ | -------------------------------- | ------------------- | --------------------- |
| GET    | `/v1/users/:id/followers`        | newest follow first | `{id, handle, since}` |
| GET    | `/v1/users/:id/following`        | newest follow first | `{id, handle, since}` |
| GET    | `/v1/users/:id/mutuals/:otherId` | by id               | `{id, handle}`        |

- **Cursors are keyset-based,** never offsets. A page walk has no duplicates or gaps while new follows arrive. When an account already returned unfollows mid-walk, the remaining items don't shift into the gap the way they would with `SKIP`.
- **Errors:** a limit outside 1-100 or a malformed cursor is `400`. An unknown user is `404`. Mutuals of a user with themselves is `400`.

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
npx tsx --env-file=.env scripts/measure-celebrity-reads.ts
```

The second script builds a 100,000-follower account, times the list queries against it, and deletes everything it created.
