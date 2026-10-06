import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import type { SinceCursor } from '../api/pagination.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import { toIsoString } from './convert.js';
import { loadCypher } from './cypher.js';
import { runRead } from './tx.js';
import type { Timeouts } from './userRepository.js';

export interface FollowItem {
  id: string;
  handle: string;
  /** ISO-8601 time the follow was created. */
  since: string;
}

export interface FollowPage {
  items: FollowItem[];
  /** Pass back to get the next page; null when there are no more. */
  next: SinceCursor | null;
}

export interface MutualItem {
  id: string;
  handle: string;
}

export interface MutualPage {
  items: MutualItem[];
  next: string | null;
}

export interface PageRequest<C> {
  /** Page size, already validated to 1..MAX_PAGE_SIZE. */
  limit: number;
  cursor: C | null;
}

/**
 * Keyset-paginated list reads (invariant 4). Each query fetches limit + 1 rows: the extra
 * row only tells us whether another page exists, so the last page has a null cursor.
 */
export class ReadRepository {
  constructor(
    private readonly driver: Driver,
    private readonly timeouts: Timeouts,
  ) {}

  followers(userId: string, page: PageRequest<SinceCursor>): Promise<FollowPage> {
    return this.followPage('followers', userId, page);
  }

  following(userId: string, page: PageRequest<SinceCursor>): Promise<FollowPage> {
    return this.followPage('following', userId, page);
  }

  async mutuals(aId: string, bId: string, page: PageRequest<string>): Promise<MutualPage> {
    if (aId === bId) throw new ValidationError('mutuals need two different users');
    const rows = await this.readItems('mutuals', {
      aId,
      bId,
      cursorId: page.cursor,
      limit: neo4j.int(page.limit + 1),
    });
    if (rows === null) throw new NotFoundError('user not found');

    const items = rows.slice(0, page.limit).map((r) => ({
      id: r.id as string,
      handle: r.handle as string,
    }));
    const last = items.at(-1);
    return { items, next: rows.length > page.limit && last ? last.id : null };
  }

  private async followPage(
    query: 'followers' | 'following',
    userId: string,
    page: PageRequest<SinceCursor>,
  ): Promise<FollowPage> {
    const rows = await this.readItems(query, {
      userId,
      cursorSince: page.cursor?.since ?? null,
      cursorId: page.cursor?.id ?? null,
      limit: neo4j.int(page.limit + 1),
    });
    if (rows === null) throw new NotFoundError('user not found');

    const items = rows.slice(0, page.limit).map((r) => ({
      id: r.id as string,
      handle: r.handle as string,
      since: toIsoString(r.since),
    }));
    const last = items.at(-1);
    return {
      items,
      next: rows.length > page.limit && last ? { since: last.since, id: last.id } : null,
    };
  }

  /** Runs a list query; null means the anchoring user(s) did not exist (zero rows). */
  private readItems(
    query: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>[] | null> {
    return runRead(this.driver, this.timeouts.readTimeoutMs, async (tx: ManagedTransaction) => {
      const result = await tx.run(loadCypher(query), params);
      const row = result.records[0];
      return row === undefined ? null : (row.get('items') as Record<string, unknown>[]);
    });
  }
}
