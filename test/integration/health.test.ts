import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { createDriver, pingNeo4j, type Driver } from '../../src/graph/driver.js';
import { createRedis, pingRedis, type Redis } from '../../src/shared/redis.js';

// Same image as docker-compose.yml. Neo4j comes from the shared globalSetup container.
const REDIS_IMAGE = 'redis:7-alpine';

describe('health check against real containers', () => {
  let redisContainer: StartedRedisContainer;
  let driver: Driver;
  let redis: Redis;

  beforeAll(async () => {
    redisContainer = await new RedisContainer(REDIS_IMAGE).start();
    driver = createDriver({
      uri: inject('neo4jUri'),
      user: 'neo4j',
      password: inject('neo4jPassword'),
      readTimeoutMs: 5000,
      writeTimeoutMs: 10_000,
    });
    redis = createRedis({ url: redisContainer.getConnectionUrl() });
    await redis.connect();
  });

  afterAll(async () => {
    await Promise.allSettled([driver.close(), redis.quit()]);
    await redisContainer.stop();
  });

  it('pings Neo4j through a managed read transaction', async () => {
    await expect(pingNeo4j(driver, 5000)).resolves.toBeUndefined();
  });

  it('pings Redis', async () => {
    await expect(pingRedis(redis)).resolves.toBeUndefined();
  });

  it('reports ready when both containers are up', async () => {
    const app = createApp({
      checks: { neo4j: () => pingNeo4j(driver, 5000), redis: () => pingRedis(redis) },
      readinessTimeoutMs: 2000,
    });
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', checks: { neo4j: 'up', redis: 'up' } });
  });
});
