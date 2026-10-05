import type { ManagedTransaction } from 'neo4j-driver';
import { loadCypher } from './cypher.js';

/**
 * Write-locks the given users in sorted id order and returns the ids that exist.
 * Must be the first statement of the transaction. See docs/adr/0001.
 */
export async function lockUsers(
  tx: ManagedTransaction,
  ids: readonly string[],
): Promise<Set<string>> {
  const sorted = [...new Set(ids)].sort();
  const result = await tx.run(loadCypher('lock-users'), { ids: sorted });
  return new Set(result.records.map((r) => r.get('id') as string));
}
