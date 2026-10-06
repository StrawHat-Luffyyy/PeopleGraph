import neo4j, { type Driver } from 'neo4j-driver';
import type { HydratedUser, RecoPorts } from '../reco/pipeline.js';
import type { CandidateSources } from '../reco/types.js';
import type { PymkConfig } from '../shared/config.js';
import { toNumber } from './convert.js';
import { loadCypher } from './cypher.js';
import { runRead } from './tx.js';
import type { Timeouts } from './userRepository.js';

export type RecoBounds = Omit<PymkConfig, 'weights'>;

/** Cypher side of the PYMK pipeline: candidate generators, filter and hydration. */
export class RecoRepository implements RecoPorts {
  constructor(
    private readonly driver: Driver,
    private readonly timeouts: Timeouts,
    private readonly bounds: RecoBounds,
  ) {}

  /** Runs the three generators in one read transaction. null if the user does not exist. */
  generate(userId: string): Promise<CandidateSources | null> {
    const limit = neo4j.int(this.bounds.candidatesPerSource);
    return runRead(this.driver, this.timeouts.readTimeoutMs, async (tx) => {
      const user = (await tx.run(loadCypher('pymk-user'), { userId })).records[0];
      if (user === undefined) return null;

      const fof = await tx.run(loadCypher('pymk-fof'), {
        userId,
        maxFriends: neo4j.int(this.bounds.maxFriends),
        maxFanout: neo4j.int(this.bounds.maxFanout),
        limit,
      });
      const interests = await tx.run(loadCypher('pymk-interests'), {
        userId,
        maxInterestFanout: neo4j.int(this.bounds.maxInterestFanout),
        limit,
      });
      const scanFollowers = toNumber(user.get('followerCount')) <= this.bounds.maxFollowersScan;
      const followsYou = scanFollowers
        ? (await tx.run(loadCypher('pymk-follows-you'), { userId, limit })).records
        : [];

      return {
        mutuals: fof.records.map((r) => ({
          id: r.get('id') as string,
          mutualCount: toNumber(r.get('mutualCount')),
          sampleMutuals: r.get('sampleMutuals') as string[],
        })),
        interests: interests.records.map((r) => ({
          id: r.get('id') as string,
          sharedInterests: toNumber(r.get('sharedInterests')),
          sampleInterests: r.get('sampleInterests') as string[],
        })),
        followsYou: followsYou.map((r) => ({ id: r.get('id') as string })),
      };
    });
  }

  filter(userId: string, ids: readonly string[]): Promise<Set<string>> {
    return runRead(this.driver, this.timeouts.readTimeoutMs, async (tx) => {
      const result = await tx.run(loadCypher('pymk-filter'), { userId, ids: [...ids] });
      return new Set(result.records.map((r) => r.get('id') as string));
    });
  }

  hydrate(ids: readonly string[]): Promise<Map<string, HydratedUser>> {
    return runRead(this.driver, this.timeouts.readTimeoutMs, async (tx) => {
      const result = await tx.run(loadCypher('pymk-hydrate'), { ids: [...ids] });
      return new Map(
        result.records.map((r) => [
          r.get('id') as string,
          {
            handle: r.get('handle') as string,
            followerCount: toNumber(r.get('followerCount')),
          },
        ]),
      );
    });
  }
}
