import { Hono } from 'hono';
import type { UserRepository } from '../../graph/userRepository.js';
import { ForbiddenError } from '../../shared/errors.js';
import { normalizeInterests } from '../../shared/interests.js';
import { requireUser, type AuthVariables } from '../auth.js';
import { readJson } from '../body.js';
import { parseCreateUser, parseUserId } from '../validation.js';

export type UserStore = Pick<UserRepository, 'createUser' | 'replaceInterests'>;

export function userRoutes(users: UserStore): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Sign-up: no caller identity yet. Idempotent on id.
  app.post('/', async (c) => {
    const input = parseCreateUser(await readJson(c));
    const { created, user } = await users.createUser(input);
    return c.json(user, created ? 201 : 200);
  });

  app.put('/:id/interests', requireUser, async (c) => {
    const id = parseUserId(c.req.param('id'));
    if (id !== c.get('userId')) throw new ForbiddenError("cannot change another user's interests");
    const body = await readJson(c);
    const raw =
      typeof body === 'object' && body !== null
        ? (body as { interests?: unknown }).interests
        : undefined;
    const interests = await users.replaceInterests(id, normalizeInterests(raw));
    return c.json({ interests });
  });

  return app;
}
