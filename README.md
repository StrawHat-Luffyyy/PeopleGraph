# PeopleGraph

Social graph service with "people you may know" recommendations, built on Neo4j and Redis.
See [docs/PEOPLEGRAPH_PLAN.md](docs/PEOPLEGRAPH_PLAN.md) for the design and phases.

## Status

Phase 0 (scaffolding): API skeleton with liveness and readiness checks, local stack, tests, CI.
No benchmark results yet. Numbers will be added here only once they are measured.

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

Neo4j Browser is at http://localhost:7474 (user `neo4j`, password from `.env`).

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
```

`test:integration` starts its own Neo4j and Redis with Testcontainers and never touches the
docker-compose databases.
