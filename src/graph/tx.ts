import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';

/**
 * Managed-transaction helpers. executeRead/executeWrite retry transient errors such as
 * deadlocks; every call has a timeout; the session is always closed. Throwing from
 * `work` rolls the transaction back (releasing its locks) without a retry.
 */
export async function runRead<T>(
  driver: Driver,
  timeoutMs: number,
  work: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    return await session.executeRead(work, { timeout: timeoutMs });
  } finally {
    await session.close();
  }
}

export async function runWrite<T>(
  driver: Driver,
  timeoutMs: number,
  work: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    return await session.executeWrite(work, { timeout: timeoutMs });
  } finally {
    await session.close();
  }
}
