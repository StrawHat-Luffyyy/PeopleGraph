import neo4j, { type Driver } from 'neo4j-driver';
import type { Config } from '../shared/config.js';
import { runRead } from './tx.js';

export type { Driver };

export function createDriver(config: Config['neo4j']): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
}

/** Round-trips a trivial read through a managed transaction. */
export async function pingNeo4j(driver: Driver, readTimeoutMs: number): Promise<void> {
  const value = await runRead(driver, readTimeoutMs, async (tx) => {
    const result = await tx.run('RETURN 1 AS ok');
    return result.records[0]?.get('ok') as unknown;
  });
  if (!neo4j.isInt(value) || value.toNumber() !== 1) {
    throw new Error('unexpected ping result');
  }
}
