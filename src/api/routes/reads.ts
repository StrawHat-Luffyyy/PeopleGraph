import { Hono } from 'hono';
import type { ReadRepository } from '../../graph/readRepository.js';
import { requireUser, type AuthVariables } from '../auth.js';
import {
  decodeIdCursor,
  decodeSinceCursor,
  encodeIdCursor,
  encodeSinceCursor,
  parseLimit,
} from '../pagination.js';
import { parseUserId } from '../validation.js';

export type ReadStore = Pick<ReadRepository, 'followers' | 'following' | 'mutuals'>;

/** Keyset-paginated list endpoints. Mounted at /v1/users. */
export function readRoutes(reads: ReadStore): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // requireUser is attached per route; see socialRoutes for why not app.use('*').
  for (const list of ['followers', 'following'] as const) {
    app.get(`/:id/${list}`, requireUser, async (c) => {
      const id = parseUserId(c.req.param('id'));
      const limit = parseLimit(c.req.query('limit'));
      const cursor = decodeSinceCursor(c.req.query('cursor'));
      const page = await reads[list](id, { limit, cursor });
      return c.json({
        items: page.items,
        nextCursor: page.next === null ? null : encodeSinceCursor(page.next),
      });
    });
  }

  app.get('/:id/mutuals/:otherId', requireUser, async (c) => {
    const id = parseUserId(c.req.param('id'));
    const otherId = parseUserId(c.req.param('otherId'), 'otherId');
    const limit = parseLimit(c.req.query('limit'));
    const cursor = decodeIdCursor(c.req.query('cursor'));
    const page = await reads.mutuals(id, otherId, { limit, cursor });
    return c.json({
      items: page.items,
      nextCursor: page.next === null ? null : encodeIdCursor(page.next),
    });
  });

  return app;
}
