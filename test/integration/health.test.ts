import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { createDriver, pingNeo4j, type Driver } from '../../src/graph/driver.js';
import { createRedis, pingRedis, type Redis } from '../../src/shared/redis.js';

// Same images as docker-compose.yml so tests and local dev run the same versions.
const NEO4J_IMAGE = 'neo4j:5.26-community';
const REDIS_IMAGE = 'redis:7-alpine';
const PASSWORD = 'testcontainers-pw';

describe('health check against real containers', () => {
  let neo4jContainer: StartedNeo4jContainer;
  let redisContainer: StartedRedisContainer;
  let driver: Driver;
  let redis: Redis;

  beforeAll(async () => {
    [neo4jContainer, redisContainer] = await Promise.all([
      new Neo4jContainer(NEO4J_IMAGE).withPassword(PASSWORD).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    driver = createDriver({
      uri: neo4jContainer.getBoltUri(),
      user: 'neo4j',
      password: PASSWORD,
      readTimeoutMs: 5000,
    });
    redis = createRedis({ url: redisContainer.getConnectionUrl() });
    await redis.connect();
  });

  afterAll(async () => {
    await Promise.allSettled([driver.close(), redis.quit()]);
    await Promise.allSettled([neo4jContainer.stop(), redisContainer.stop()]);
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
