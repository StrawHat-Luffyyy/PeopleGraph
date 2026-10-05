import { serve } from '@hono/node-server';
import { createApp } from './api/app.js';
import { createDriver, pingNeo4j } from './graph/driver.js';
import { loadConfig } from './shared/config.js';
import { createLogger } from './shared/logger.js';
import { createRedis, pingRedis } from './shared/redis.js';

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const driver = createDriver(config.neo4j);
const redis = createRedis(config.redis);
redis.on('error', (err: unknown) => {
  logger.warn({ err }, 'redis connection error');
});

const app = createApp({
  checks: {
    neo4j: () => pingNeo4j(driver, config.neo4j.readTimeoutMs),
    redis: () => pingRedis(redis),
  },
  readinessTimeoutMs: config.readinessTimeoutMs,
  logger,
});

// Connect in the background; /readyz reports 503 until both dependencies answer.
redis.connect().catch((err: unknown) => {
  logger.warn({ err }, 'initial redis connect failed');
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, 'peoplegraph api listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([driver.close(), redis.quit()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
