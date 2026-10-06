import { Hono } from 'hono';
import type { Recommendation } from '../../reco/types.js';
import { requireUser, type AuthVariables } from '../auth.js';
import { parseLimit } from '../pagination.js';

/** Max recommendations per request. A ranked top-N, so no cursor (invariant 4 via the cap). */
export const MAX_RECOMMENDATIONS = 50;

export interface RecommendationService {
  recommend(userId: string, limit: number): Promise<Recommendation[]>;
}

/** Mounted at /v1/recommendations. */
export function recommendationRoutes(
  service: RecommendationService,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get('/people', requireUser, async (c) => {
    const limit = parseLimit(c.req.query('limit'), MAX_RECOMMENDATIONS);
    const items = await service.recommend(c.get('userId'), limit);
    return c.json({ items });
  });

  return app;
}
