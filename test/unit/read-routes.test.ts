import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/app.js';
import { encodeIdCursor, encodeSinceCursor } from '../../src/api/pagination.js';
import { NotFoundError, ValidationError } from '../../src/shared/errors.js';

type Reads = NonNullable<AppDeps['reads']>;

function setup() {
  const reads = {
    followers: vi.fn<Reads['followers']>(),
    following: vi.fn<Reads['following']>(),
    mutuals: vi.fn<Reads['mutuals']>(),
  };
  const app = createApp({
    checks: { neo4j: () => Promise.resolve(), redis: () => Promise.resolve() },
    readinessTimeoutMs: 50,
    reads,
  });
  const get = (path: string, userId = 'viewer') =>
    app.request(path, { headers: { 'x-user-id': userId } });
  return { reads, get, app };
}

const item = { id: 'f1', handle: 'fan_one', since: '2026-10-05T15:00:41.123456789Z' };

describe('GET /v1/users/:id/followers', () => {
  it('returns items and an encoded next cursor', async () => {
    const { reads, get } = setup();
    reads.followers.mockResolvedValue({ items: [item], next: { since: item.since, id: 'f1' } });
    const res = await get('/v1/users/star/followers?limit=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [item],
      nextCursor: encodeSinceCursor({ since: item.since, id: 'f1' }),
    });
    expect(reads.followers).toHaveBeenCalledWith('star', { limit: 1, cursor: null });
  });

  it('passes a decoded cursor and the default limit', async () => {
    const { reads, get } = setup();
    reads.followers.mockResolvedValue({ items: [], next: null });
    const cursor = { since: item.since, id: 'f9' };
    const res = await get(`/v1/users/star/followers?cursor=${encodeSinceCursor(cursor)}`);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
    expect(reads.followers).toHaveBeenCalledWith('star', { limit: 20, cursor });
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=abc',
    'cursor=garbage!',
    `cursor=${encodeIdCursor('x')}`,
  ])('returns 400 for %s without querying', async (query) => {
    const { reads, get } = setup();
    expect((await get(`/v1/users/star/followers?${query}`)).status).toBe(400);
    expect(reads.followers).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed user id and 401 without a caller', async () => {
    const { get, app } = setup();
    expect((await get('/v1/users/bad%20id/followers')).status).toBe(400);
    expect((await app.request('/v1/users/star/followers')).status).toBe(401);
  });

  it('maps NotFoundError to 404', async () => {
    const { reads, get } = setup();
    reads.followers.mockRejectedValue(new NotFoundError('user not found'));
    expect((await get('/v1/users/ghost/followers')).status).toBe(404);
  });
});

describe('GET /v1/users/:id/following', () => {
  it('uses the following store with the same contract', async () => {
    const { reads, get } = setup();
    reads.following.mockResolvedValue({ items: [item], next: null });
    const res = await get('/v1/users/me/following?limit=5');
    expect(await res.json()).toEqual({ items: [item], nextCursor: null });
    expect(reads.following).toHaveBeenCalledWith('me', { limit: 5, cursor: null });
  });
});

describe('GET /v1/users/:id/mutuals/:otherId', () => {
  it('returns items with an id cursor', async () => {
    const { reads, get } = setup();
    reads.mutuals.mockResolvedValue({ items: [{ id: 'm1', handle: 'mm1' }], next: 'm1' });
    const res = await get(`/v1/users/a/mutuals/b?limit=1&cursor=${encodeIdCursor('m0')}`);
    expect(await res.json()).toEqual({
      items: [{ id: 'm1', handle: 'mm1' }],
      nextCursor: encodeIdCursor('m1'),
    });
    expect(reads.mutuals).toHaveBeenCalledWith('a', 'b', { limit: 1, cursor: 'm0' });
  });

  it('returns 400 for a since cursor and for mutuals with yourself', async () => {
    const { reads, get } = setup();
    const sinceCursor = encodeSinceCursor({ since: item.since, id: 'x' });
    expect((await get(`/v1/users/a/mutuals/b?cursor=${sinceCursor}`)).status).toBe(400);
    reads.mutuals.mockRejectedValue(new ValidationError('mutuals need two different users'));
    expect((await get('/v1/users/a/mutuals/a')).status).toBe(400);
  });
});

describe('route mounting', () => {
  it('does not put sign-up behind auth when read routes are mounted', async () => {
    const { app } = setup();
    // No users store is wired here, so 404 (not 401) proves no auth middleware leaked.
    const res = await app.request('/v1/users', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});
