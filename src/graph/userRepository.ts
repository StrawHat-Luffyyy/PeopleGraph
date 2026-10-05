import { Neo4jError, type Driver } from 'neo4j-driver';
import { ConflictError, NotFoundError } from '../shared/errors.js';
import { toNumber } from './convert.js';
import { loadCypher } from './cypher.js';
import { lockUsers } from './locks.js';
import { runWrite } from './tx.js';

export interface UserSummary {
  id: string;
  handle: string;
  followerCount: number;
  followingCount: number;
}

export interface NewUser {
  id: string;
  handle: string;
  name: string;
}

export interface Timeouts {
  readTimeoutMs: number;
  writeTimeoutMs: number;
}

const CONSTRAINT_FAILED = 'Neo.ClientError.Schema.ConstraintValidationFailed';

export class UserRepository {
  constructor(
    private readonly driver: Driver,
    private readonly timeouts: Timeouts,
  ) {}

  /**
   * Idempotent create. The same id and handle again returns the existing user with
   * created=false. A handle owned by another id, or an existing id with a different
   * handle, throws ConflictError.
   */
  async createUser(input: NewUser): Promise<{ created: boolean; user: UserSummary }> {
    let row;
    try {
      row = await runWrite(this.driver, this.timeouts.writeTimeoutMs, async (tx) => {
        const result = await tx.run(loadCypher('create-user'), { ...input });
        return result.records[0];
      });
    } catch (err) {
      if (err instanceof Neo4jError && err.code === CONSTRAINT_FAILED) {
        throw new ConflictError('handle is already taken', { cause: err });
      }
      throw err;
    }
    if (row === undefined) throw new Error('create-user returned no row');

    const user: UserSummary = {
      id: row.get('id') as string,
      handle: row.get('handle') as string,
      followerCount: toNumber(row.get('followerCount')),
      followingCount: toNumber(row.get('followingCount')),
    };
    const created = row.get('created') as boolean;
    if (!created && user.handle !== input.handle) {
      throw new ConflictError('a user with this id already exists with a different handle');
    }
    return { created, user };
  }

  /** Replaces the user's interests with an already-normalized list. Returns them sorted. */
  async replaceInterests(userId: string, interests: readonly string[]): Promise<string[]> {
    return runWrite(this.driver, this.timeouts.writeTimeoutMs, async (tx) => {
      const found = await lockUsers(tx, [userId]);
      if (!found.has(userId)) throw new NotFoundError('user not found');
      const result = await tx.run(loadCypher('replace-interests'), { userId, interests });
      return result.records.map((r) => r.get('name') as string).sort();
    });
  }
}
