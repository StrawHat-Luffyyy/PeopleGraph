import { Hono } from 'hono';
import { HttpError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { socialRoutes, type SocialStore } from './routes/social.js';
import { userRoutes, type UserStore } from './routes/users.js';

/** Resolves when the dependency is reachable, rejects otherwise. */
export type HealthCheck = () => Promise<void>;

export interface AppDeps {
  checks: { neo4j: HealthCheck; redis: HealthCheck };
  readinessTimeoutMs: number;
  logger?: Logger;
  /** Routes for each store are mounted only when it is provided. */
  users?: UserStore;
  social?: SocialStore;
}

type CheckState = 'up' | 'down';

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/readyz', async (c) => {
    const names = Object.keys(deps.checks) as (keyof AppDeps['checks'])[];
    const results = await Promise.allSettled(
      names.map((name) => runCheck(deps.checks[name], deps.readinessTimeoutMs)),
    );

    const checks = {} as Record<keyof AppDeps['checks'], CheckState>;
    results.forEach((result, i) => {
      const name = names[i];
      if (name === undefined) return;
      checks[name] = result.status === 'fulfilled' ? 'up' : 'down';
      if (result.status === 'rejected') {
        deps.logger?.warn(
          { dependency: name, err: result.reason as unknown },
          'readiness check failed',
        );
      }
    });

    const ready = Object.values(checks).every((s) => s === 'up');
    return c.json({ status: ready ? 'ready' : 'unavailable', checks }, ready ? 200 : 503);
  });

  if (deps.users) app.route('/v1/users', userRoutes(deps.users));
  if (deps.social) app.route('/v1', socialRoutes(deps.social));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    // HttpError messages are written for clients and carry no PII; anything else is a
    // bug or an infrastructure failure, so log it and return no details.
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message }, err.status);
    }
    deps.logger?.error({ err }, 'unhandled error');
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
