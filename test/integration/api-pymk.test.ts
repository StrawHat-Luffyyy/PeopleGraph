import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { RecoRepository } from '../../src/graph/recoRepository.js';
import { recommend } from '../../src/reco/pipeline.js';
import { createUsers, timeouts, useGraph } from './support/graph.js';

describe('GET /v1/recommendations/people end to end (real Neo4j)', () => {
  const g = useGraph();
  const app = () => {
    const reco = new RecoRepository(g.driver, timeouts, {
      maxFriends: 200,
      maxFanout: 1000,
      maxInterestFanout: 5000,
      maxFollowersScan: 5000,
      candidatesPerSource: 100,
    });
    return createApp({
      checks: { neo4j: () => Promise.resolve(), redis: () => Promise.resolve() },
      readinessTimeoutMs: 1000,
      social: g.social,
      recommendations: {
        recommend: (userId, limit) =>
          recommend(userId, limit, reco, { mutual: 3, interest: 2, followsYou: 5 }),
      },
    });
  };
  const as = (userId: string, method = 'GET') => ({ method, headers: { 'x-user-id': userId } });

  it('recommends, then stops recommending someone once they are followed over HTTP', async () => {
    await createUsers(g.users, 'me', 'friend', 'cand');
    await g.social.follow('me', 'friend');
    await g.social.follow('friend', 'cand');

    const first = await app().request('/v1/recommendations/people', as('me'));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      items: [
        {
          id: 'cand',
          handle: 'h_cand',
          followerCount: 1,
          reasons: [{ type: 'mutuals', count: 1, sample: ['h_friend'] }],
          explanation: 'followed by h_friend',
        },
      ],
    });

    expect((await app().request('/v1/follow/cand', as('me', 'POST'))).status).toBe(201);
    const after = await app().request('/v1/recommendations/people', as('me'));
    expect(await after.json()).toEqual({ items: [] });

    expect((await app().request('/v1/recommendations/people', as('ghost'))).status).toBe(404);
    expect((await app().request('/v1/recommendations/people?limit=51', as('me'))).status).toBe(400);
  });
});
