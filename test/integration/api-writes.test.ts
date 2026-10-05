import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { counters, edgeCount, interestsOf, useGraph } from './support/graph.js';

describe('write endpoints end to end (real Neo4j)', () => {
  const g = useGraph();
  const app = () =>
    createApp({
      checks: { neo4j: () => Promise.resolve(), redis: () => Promise.resolve() },
      readinessTimeoutMs: 1000,
      users: g.users,
      social: g.social,
    });

  const signUp = (id: string, handle: string) =>
    app().request('/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, handle, name: `Name ${id}` }),
    });
  const call = (method: string, path: string, userId: string, body?: unknown) =>
    app().request(path, {
      method,
      headers: { 'x-user-id': userId, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('create, interests, follow, unfollow, block, then follow is forbidden', async () => {
    expect((await signUp('ana', 'ana')).status).toBe(201);
    expect((await signUp('raj', 'raj')).status).toBe(201);
    expect((await signUp('ana', 'ana')).status).toBe(200);
    expect((await signUp('other', 'ana')).status).toBe(409);

    const interests = await call('PUT', '/v1/users/ana/interests', 'ana', {
      interests: ['Rust', ' chess '],
    });
    expect(interests.status).toBe(200);
    expect(await interestsOf(g.driver, 'ana')).toEqual(['chess', 'rust']);

    expect((await call('POST', '/v1/follow/raj', 'ana')).status).toBe(201);
    expect((await call('POST', '/v1/follow/raj', 'ana')).status).toBe(200);
    expect((await call('POST', '/v1/follow/ana', 'raj')).status).toBe(201);
    expect(await counters(g.driver, 'raj')).toEqual({ followers: 1, following: 1 });

    expect((await call('DELETE', '/v1/follow/raj', 'ana')).status).toBe(204);
    expect((await call('DELETE', '/v1/follow/raj', 'ana')).status).toBe(204);
    expect(await edgeCount(g.driver, 'FOLLOWS', 'ana', 'raj')).toBe(0);

    expect((await call('POST', '/v1/block/raj', 'ana')).status).toBe(201);
    expect(await edgeCount(g.driver, 'FOLLOWS', 'raj', 'ana')).toBe(0);
    expect((await call('POST', '/v1/follow/raj', 'ana')).status).toBe(403);
    expect((await call('POST', '/v1/follow/ana', 'raj')).status).toBe(403);

    expect((await call('POST', '/v1/follow/ghost', 'ana')).status).toBe(404);
    expect((await call('POST', '/v1/follow/ana', 'ana')).status).toBe(400);
  });
});
