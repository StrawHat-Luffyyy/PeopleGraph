import { ConfigError } from './errors.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  port: number;
  logLevel: LogLevel;
  neo4j: {
    uri: string;
    user: string;
    password: string;
    /** Transaction timeout applied to every read transaction. */
    readTimeoutMs: number;
    /** Transaction timeout for writes, so lock-holding transactions cannot hang. */
    writeTimeoutMs: number;
  };
  redis: { url: string };
  /** Upper bound for each dependency ping in /readyz. */
  readinessTimeoutMs: number;
  /** People-you-may-know weights and traversal bounds. See docs/adr/0002. */
  pymk: PymkConfig;
}

export interface PymkConfig {
  weights: { mutual: number; interest: number; followsYou: number };
  /** Friends-of-friends expands only from this many of my most recent follows. */
  maxFriends: number;
  /** Friends-of-friends skips friends who follow more accounts than this. */
  maxFanout: number;
  /** Shared interests skips interests with more members than this. */
  maxInterestFanout: number;
  /** Follows-you runs only for users with at most this many followers. */
  maxFollowersScan: number;
  /** LIMIT on each candidate generator. */
  candidatesPerSource: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const NEO4J_SCHEMES = ['bolt:', 'bolt+s:', 'bolt+ssc:', 'neo4j:', 'neo4j+s:', 'neo4j+ssc:'];
const REDIS_SCHEMES = ['redis:', 'rediss:'];

/**
 * Builds the config from environment variables. Pure: pass `process.env` at the edge.
 * Defaults match docker-compose.yml, except the password, which has no default.
 * Error messages name the variable but never echo its value.
 */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const intInRange = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };

  const url = (name: string, fallback: string, schemes: readonly string[]): string => {
    const raw = env[name] ?? fallback;
    let protocol: string | undefined;
    try {
      protocol = new URL(raw).protocol;
    } catch {
      protocol = undefined;
    }
    if (protocol === undefined || !schemes.includes(protocol)) {
      problems.push(`${name} must be a URL with scheme ${schemes.join(' | ')}`);
    }
    return raw;
  };

  const port = intInRange('PORT', 3000, 1, 65535);

  const logLevelRaw = env.LOG_LEVEL ?? 'info';
  const logLevel = LOG_LEVELS.find((l) => l === logLevelRaw);
  if (logLevel === undefined) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const password = env.NEO4J_PASSWORD;
  if (password === undefined || password === '') problems.push('NEO4J_PASSWORD is required');

  const neo4jUri = url('NEO4J_URI', 'bolt://localhost:7687', NEO4J_SCHEMES);
  const redisUrl = url('REDIS_URL', 'redis://localhost:6379', REDIS_SCHEMES);
  const readTimeoutMs = intInRange('NEO4J_READ_TIMEOUT_MS', 5000, 1, 600_000);
  const writeTimeoutMs = intInRange('NEO4J_WRITE_TIMEOUT_MS', 10_000, 1, 600_000);
  const readinessTimeoutMs = intInRange('READINESS_TIMEOUT_MS', 2000, 1, 60_000);

  const weight = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n > 1000) {
      problems.push(`${name} must be a number between 0 and 1000`);
      return fallback;
    }
    return n;
  };
  const pymk: PymkConfig = {
    weights: {
      mutual: weight('PYMK_W_MUTUAL', 3),
      interest: weight('PYMK_W_INTEREST', 2),
      followsYou: weight('PYMK_W_FOLLOWS_YOU', 5),
    },
    maxFriends: intInRange('PYMK_MAX_FRIENDS', 200, 1, 10_000),
    maxFanout: intInRange('PYMK_MAX_FANOUT', 1000, 1, 1_000_000),
    maxInterestFanout: intInRange('PYMK_MAX_INTEREST_FANOUT', 5000, 1, 1_000_000),
    maxFollowersScan: intInRange('PYMK_MAX_FOLLOWERS_SCAN', 5000, 1, 1_000_000),
    candidatesPerSource: intInRange('PYMK_CANDIDATES_PER_SOURCE', 100, 1, 1000),
  };

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    logLevel: logLevel ?? 'info',
    neo4j: {
      uri: neo4jUri,
      user: env.NEO4J_USER ?? 'neo4j',
      password: password ?? '',
      readTimeoutMs,
      writeTimeoutMs,
    },
    redis: { url: redisUrl },
    readinessTimeoutMs,
    pymk,
  };
}
