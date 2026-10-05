import { Hono } from 'hono';
import type { SocialRepository } from '../../graph/socialRepository.js';
import { requireUser, type AuthVariables } from '../auth.js';
import { parseUserId } from '../validation.js';

export type SocialStore = Pick<SocialRepository, 'follow' | 'unfollow' | 'block'>;

export function socialRoutes(social: SocialStore): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  // Middleware is attached per route: a sub-app '*' middleware would leak onto every
  // /v1/* route once mounted, including sign-up.
  app.post('/follow/:targetId', requireUser, async (c) => {
    const targetId = parseUserId(c.req.param('targetId'), 'targetId');
    const { created } = await social.follow(c.get('userId'), targetId);
    return c.json({ following: true, created }, created ? 201 : 200);
  });

  // Idempotent: 204 whether or not an edge existed.
  app.delete('/follow/:targetId', requireUser, async (c) => {
    const targetId = parseUserId(c.req.param('targetId'), 'targetId');
    await social.unfollow(c.get('userId'), targetId);
    return c.body(null, 204);
  });

  app.post('/block/:targetId', requireUser, async (c) => {
    const targetId = parseUserId(c.req.param('targetId'), 'targetId');
    const { created } = await social.block(c.get('userId'), targetId);
    return c.json({ blocked: true, created }, created ? 201 : 200);
  });

  return app;
}
