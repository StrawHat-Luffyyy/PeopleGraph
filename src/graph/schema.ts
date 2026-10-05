import type { Driver } from 'neo4j-driver';
import { loadCypher } from './cypher.js';

/** Splits schema.cypher into statements, dropping // comment lines. */
export function schemaStatements(): string[] {
  return loadCypher('schema')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Applies constraints at startup. Idempotent. Schema commands cannot share a transaction
 * with data writes, so each runs as its own auto-commit statement.
 */
export async function applySchema(driver: Driver): Promise<void> {
  for (const statement of schemaStatements()) {
    await driver.executeQuery(statement);
  }
}
