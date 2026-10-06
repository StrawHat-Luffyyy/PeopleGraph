import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/app.js';
import { NotFoundError } from '../../src/shared/errors.js';

type Recs = NonNullable<AppDeps['recommendations']>;

function setup() {
  const recommendations = { recommend: vi.fn<Recs['recommend']>() };
  const app = createApp({
    checks: { neo4j: () => Promise.resolve(), redis: () => Promise.resolve() },
    readinessTimeoutMs: 50,
    recommendations,
  });
  const get = (path: string, userId?: string) =>
    app.request(path, { headers: userId === undefined ? {} : { 'x-user-id': userId } });
  return { recommendations, get };
}

const rec = {
  id: 'c1',
  handle: 'h_c1',
  followerCount: 3,
  reasons: [{ type: 'follows_you' as const }],
  explanation: 'follows you',
};

describe('GET /v1/recommendations/people', () => {
  it('returns recommendations for the caller with the default limit of 20', async () => {
    const { recommendations, get } = setup();
    recommendations.recommend.mockResolvedValue([rec]);
    const res = await get('/v1/recommendations/people', 'me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [rec] });
    expect(recommendations.recommend).toHaveBeenCalledWith('me', 20);
  });

  it('accepts a limit up to 50', async () => {
    const { recommendations, get } = setup();
    recommendations.recommend.mockResolvedValue([]);
    expect((await get('/v1/recommendations/people?limit=50', 'me')).status).toBe(200);
    expect(recommendations.recommend).toHaveBeenCalledWith('me', 50);
  });

  it.each(['0', '51', '100', 'x'])('returns 400 for limit=%s', async (limit) => {
    const { recommendations, get } = setup();
    expect((await get(`/v1/recommendations/people?limit=${limit}`, 'me')).status).toBe(400);
    expect(recommendations.recommend).not.toHaveBeenCalled();
  });

  it('returns 401 without a caller and 404 for an unknown caller', async () => {
    const { recommendations, get } = setup();
    expect((await get('/v1/recommendations/people')).status).toBe(401);
    recommendations.recommend.mockRejectedValue(new NotFoundError('user not found'));
    expect((await get('/v1/recommendations/people', 'ghost')).status).toBe(404);
  });
});
