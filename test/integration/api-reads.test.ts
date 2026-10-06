import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { ReadRepository } from '../../src/graph/readRepository.js';
import { timeouts, useGraph } from './support/graph.js';

interface ListBody {
  items: { id: string; handle: string; since?: string }[];
  nextCursor: string | null;
}

describe('read endpoints end to end (real Neo4j, all routes mounted)', () => {
  const g = useGraph();
  const app = () =>
    createApp({
      checks: { neo4j: () => Promise.resolve(), redis: () => Promise.resolve() },
      readinessTimeoutMs: 1000,
      users: g.users,
      social: g.social,
      reads: new ReadRepository(g.driver, timeouts),
    });
  const as = (userId: string, method = 'GET') => ({ method, headers: { 'x-user-id': userId } });

  it('sign up, follow, then walk /followers over HTTP via nextCursor', async () => {
    const fans = Array.from({ length: 23 }, (_, i) => `fan${String(i).padStart(2, '0')}`);
    for (const id of ['star', ...fans]) {
      const res = await app().request('/v1/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, handle: `h_${id}`, name: `Name ${id}` }),
      });
      expect(res.status).toBe(201); // sign-up stays public with read routes mounted
    }
    for (const fan of fans) {
      expect((await app().request('/v1/follow/star', as(fan, 'POST'))).status).toBe(201);
    }

    const seen: string[] = [];
    let url: string | null = '/v1/users/star/followers?limit=10';
    let pages = 0;
    while (url !== null) {
      const res = await app().request(url, as('viewer'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListBody;
      seen.push(...body.items.map((i) => i.id));
      pages++;
      url =
        body.nextCursor === null
          ? null
          : `/v1/users/star/followers?limit=10&cursor=${body.nextCursor}`;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual([...fans].reverse()); // followed in order, so newest first

    const following = (await (
      await app().request('/v1/users/fan00/following', as('viewer'))
    ).json()) as ListBody;
    expect(following.items.map((i) => i.id)).toEqual(['star']);

    expect((await app().request('/v1/users/star/followers?cursor=nope!', as('v'))).status).toBe(
      400,
    );
    expect((await app().request('/v1/users/star/followers?limit=500', as('v'))).status).toBe(400);
    expect((await app().request('/v1/users/ghost/followers', as('v'))).status).toBe(404);
  });

  it('mutuals over HTTP', async () => {
    for (const id of ['ana', 'raj', 'm1', 'm2', 'm3']) {
      await g.users.createUser({ id, handle: `h_${id}`, name: `Name ${id}` });
    }
    for (const m of ['m1', 'm2', 'm3']) {
      await g.social.follow('ana', m);
      if (m !== 'm2') await g.social.follow('raj', m);
    }
    const res = await app().request('/v1/users/ana/mutuals/raj', as('viewer'));
    expect(await res.json()).toEqual({
      items: [
        { id: 'm1', handle: 'h_m1' },
        { id: 'm3', handle: 'h_m3' },
      ],
      nextCursor: null,
    });
    expect((await app().request('/v1/users/ana/mutuals/ana', as('viewer'))).status).toBe(400);
  });
});
