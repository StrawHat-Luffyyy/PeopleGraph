/** Friends-of-friends: accounts followed by people I follow. */
export interface MutualSignal {
  id: string;
  /** How many of the accounts I follow also follow this candidate. */
  mutualCount: number;
  /** Up to 3 handles of those accounts, sorted, for the explanation. */
  sampleMutuals: string[];
}

/** Shared interests: accounts interested in the same things as me. */
export interface InterestSignal {
  id: string;
  sharedInterests: number;
  /** Up to 3 shared interest names, sorted. */
  sampleInterests: string[];
}

/** Accounts that follow me but I don't follow back. */
export interface FollowsYouSignal {
  id: string;
}

/** Raw output of the three candidate generators. */
export interface CandidateSources {
  mutuals: MutualSignal[];
  interests: InterestSignal[];
  followsYou: FollowsYouSignal[];
}

export interface Weights {
  mutual: number;
  interest: number;
  followsYou: number;
}

/** One candidate with every signal merged and a blended score. */
export interface ScoredCandidate {
  id: string;
  score: number;
  mutualCount: number;
  sampleMutuals: string[];
  sharedInterests: number;
  sampleInterests: string[];
  followsYou: boolean;
}

export type Reason =
  | { type: 'mutuals'; count: number; sample: string[] }
  | { type: 'interests'; count: number; sample: string[] }
  | { type: 'follows_you' };

export interface Recommendation {
  id: string;
  handle: string;
  followerCount: number;
  reasons: Reason[];
  explanation: string;
}
