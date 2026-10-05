import { describe, expect, it } from 'vitest';
import { createApp, type HealthCheck } from '../../src/api/app.js';

const up: HealthCheck = () => Promise.resolve();
const down: HealthCheck = () => Promise.reject(new Error('connection refused'));
const hang: HealthCheck = () => new Promise<void>(() => undefined);

function app(neo4j: HealthCheck, redis: HealthCheck) {
  return createApp({ checks: { neo4j, redis }, readinessTimeoutMs: 50 });
}

describe('GET /healthz', () => {
  it('is 200 even when dependencies are down (liveness only)', async () => {
    const res = await app(down, down).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('is 200 when both dependencies answer', async () => {
    const res = await app(up, up).request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', checks: { neo4j: 'up', redis: 'up' } });
  });

  it('is 503 and names the failed dependency', async () => {
    const res = await app(up, down).request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'unavailable',
      checks: { neo4j: 'up', redis: 'down' },
    });
  });

  it('treats a hanging check as down once the timeout passes', async () => {
    const started = Date.now();
    const res = await app(hang, up).request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ checks: { neo4j: 'down', redis: 'up' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not leak error details to the client', async () => {
    const res = await app(down, up).request('/readyz');
    expect(await res.text()).not.toContain('connection refused');
  });
});

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const res = await app(up, up).request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
