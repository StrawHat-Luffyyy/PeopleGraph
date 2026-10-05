import neo4j, { type Driver } from 'neo4j-driver';
import type { Config } from '../shared/config.js';

export type { Driver };

export function createDriver(config: Config['neo4j']): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), {
    disableLosslessIntegers: false,
  });
}

/**
 * Round-trips a trivial read through a managed transaction. This is the template every
 * repository follows: executeRead/executeWrite, a timeout on reads, session closed in finally.
 */
export async function pingNeo4j(driver: Driver, readTimeoutMs: number): Promise<void> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const value = await session.executeRead(
      async (tx) => {
        const result = await tx.run('RETURN 1 AS ok');
        return result.records[0]?.get('ok') as unknown;
      },
      { timeout: readTimeoutMs },
    );
    if (!neo4j.isInt(value) || value.toNumber() !== 1) {
      throw new Error('unexpected ping result');
    }
  } finally {
    await session.close();
  }
}
