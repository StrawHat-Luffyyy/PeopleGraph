import { Redis } from 'ioredis';
import type { Config } from './config.js';

export type { Redis };

export function createRedis(config: Config['redis']): Redis {
  return new Redis(config.url, {
    // Fail fast instead of queueing commands forever while Redis is down;
    // the limiter and cache decide how to degrade.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

export async function pingRedis(redis: Redis): Promise<void> {
  await redis.ping();
}
