import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/app.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../src/shared/errors.js';

const up = () => Promise.resolve();

function fakes() {
  return {
    users: {
      createUser: vi.fn<NonNullable<AppDeps['users']>['createUser']>(),
      replaceInterests: vi.fn<NonNullable<AppDeps['users']>['replaceInterests']>(),
    },
    social: {
      follow: vi.fn<NonNullable<AppDeps['social']>['follow']>(),
      unfollow: vi.fn<NonNullable<AppDeps['social']>['unfollow']>(),
      block: vi.fn<NonNullable<AppDeps['social']>['block']>(),
    },
  };
}

function setup() {
  const f = fakes();
  const app = createApp({
    checks: { neo4j: up, redis: up },
    readinessTimeoutMs: 50,
    users: f.users,
    social: f.social,
  });
  return { app, ...f };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const as = (userId: string, init: RequestInit = { method: 'POST' }): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), 'x-user-id': userId },
});

describe('POST /v1/users', () => {
  const user = { id: 'u1', handle: 'ana', followerCount: 0, followingCount: 0 };

  it('returns 201 with the user when created', async () => {
    const { app, users } = setup();
    users.createUser.mockResolvedValue({ created: true, user });
    const res = await app.request('/v1/users', json({ id: 'u1', handle: 'Ana', name: ' Ana ' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(user);
    expect(users.createUser).toHaveBeenCalledWith({ id: 'u1', handle: 'ana', name: 'Ana' });
  });

  it('returns 200 when the user already existed', async () => {
    const { app, users } = setup();
    users.createUser.mockResolvedValue({ created: false, user });
    const res = await app.request('/v1/users', json({ id: 'u1', handle: 'ana', name: 'Ana' }));
    expect(res.status).toBe(200);
  });

  it('returns 400 for an invalid body without calling the repository', async () => {
    const { app, users } = setup();
    const res = await app.request('/v1/users', json({ id: 'bad id', handle: 'ana', name: 'A' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const { app } = setup();
    const res = await app.request('/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('maps ConflictError to 409', async () => {
    const { app, users } = setup();
    users.createUser.mockRejectedValue(new ConflictError('handle is already taken'));
    const res = await app.request('/v1/users', json({ id: 'u1', handle: 'ana', name: 'Ana' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', message: 'handle is already taken' });
  });
});

describe('PUT /v1/users/:id/interests', () => {
  const put = (body: unknown, userId?: string): RequestInit => ({
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(userId === undefined ? {} : { 'x-user-id': userId }),
    },
    body: JSON.stringify(body),
  });

  it('normalizes and stores interests for the caller', async () => {
    const { app, users } = setup();
    users.replaceInterests.mockResolvedValue(['chess', 'rust']);
    const res = await app.request(
      '/v1/users/u1/interests',
      put({ interests: [' Rust', 'chess', 'RUST'] }, 'u1'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interests: ['chess', 'rust'] });
    expect(users.replaceInterests).toHaveBeenCalledWith('u1', ['rust', 'chess']);
  });

  it('returns 401 without a caller', async () => {
    const { app } = setup();
    const res = await app.request('/v1/users/u1/interests', put({ interests: [] }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when changing someone else's interests", async () => {
    const { app, users } = setup();
    const res = await app.request('/v1/users/u2/interests', put({ interests: [] }, 'u1'));
    expect(res.status).toBe(403);
    expect(users.replaceInterests).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid interest list', async () => {
    const { app } = setup();
    const res = await app.request('/v1/users/u1/interests', put({ interests: 'rust' }, 'u1'));
    expect(res.status).toBe(400);
  });
});

describe('follow, unfollow, block', () => {
  it('requires X-User-Id (401 when missing or malformed)', async () => {
    const { app, social } = setup();
    expect((await app.request('/v1/follow/u2', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/v1/follow/u2', as('bad id'))).status).toBe(401);
    expect(social.follow).not.toHaveBeenCalled();
  });

  it('POST /v1/follow returns 201 for a new edge, 200 for an existing one', async () => {
    const { app, social } = setup();
    social.follow
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false });
    const first = await app.request('/v1/follow/u2', as('u1'));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ following: true, created: true });
    expect((await app.request('/v1/follow/u2', as('u1'))).status).toBe(200);
    expect(social.follow).toHaveBeenCalledWith('u1', 'u2');
  });

  it('returns 400 for a malformed target id', async () => {
    const { app } = setup();
    expect((await app.request('/v1/follow/bad%20id', as('u1'))).status).toBe(400);
  });

  it.each([
    [new ValidationError('cannot follow yourself'), 400],
    [new ForbiddenError('cannot follow this user'), 403],
    [new NotFoundError('user not found'), 404],
  ])('maps %s to %i', async (error, status) => {
    const { app, social } = setup();
    social.follow.mockRejectedValue(error);
    expect((await app.request('/v1/follow/u2', as('u1'))).status).toBe(status);
  });

  it('DELETE /v1/follow returns 204 whether or not an edge existed', async () => {
    const { app, social } = setup();
    social.unfollow
      .mockResolvedValueOnce({ removed: true })
      .mockResolvedValueOnce({ removed: false });
    const del = as('u1', { method: 'DELETE' });
    expect((await app.request('/v1/follow/u2', del)).status).toBe(204);
    expect((await app.request('/v1/follow/u2', del)).status).toBe(204);
  });

  it('POST /v1/block returns 201 for a new block, 200 when repeated', async () => {
    const { app, social } = setup();
    social.block.mockResolvedValueOnce({ created: true }).mockResolvedValueOnce({ created: false });
    const first = await app.request('/v1/block/u2', as('u1'));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ blocked: true, created: true });
    expect((await app.request('/v1/block/u2', as('u1'))).status).toBe(200);
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const { app, social } = setup();
    social.follow.mockRejectedValue(new Error('Neo.TransientError secret internals'));
    const res = await app.request('/v1/follow/u2', as('u1'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret internals');
  });
});
