import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';
import { ConfigError } from '../../src/shared/errors.js';

const minimal = { NEO4J_PASSWORD: 'secret' };

function expectConfigError(env: Record<string, string>, field: string): void {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems.some((p) => p.startsWith(field))).toBe(true);
    return;
  }
  expect.unreachable(`expected ConfigError for ${field}`);
}

describe('loadConfig', () => {
  it('applies local-dev defaults when only the password is set', () => {
    expect(loadConfig(minimal)).toEqual({
      port: 3000,
      logLevel: 'info',
      neo4j: {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'secret',
        readTimeoutMs: 5000,
        writeTimeoutMs: 10000,
      },
      redis: { url: 'redis://localhost:6379' },
      readinessTimeoutMs: 2000,
    });
  });

  it('reads every value from the environment', () => {
    const config = loadConfig({
      PORT: '8080',
      LOG_LEVEL: 'debug',
      NEO4J_URI: 'neo4j+s://example.databases.neo4j.io',
      NEO4J_USER: 'reader',
      NEO4J_PASSWORD: 'pw',
      NEO4J_READ_TIMEOUT_MS: '1500',
      NEO4J_WRITE_TIMEOUT_MS: '2500',
      REDIS_URL: 'rediss://cache:6380',
      READINESS_TIMEOUT_MS: '750',
    });
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('debug');
    expect(config.neo4j).toEqual({
      uri: 'neo4j+s://example.databases.neo4j.io',
      user: 'reader',
      password: 'pw',
      readTimeoutMs: 1500,
      writeTimeoutMs: 2500,
    });
    expect(config.redis.url).toBe('rediss://cache:6380');
    expect(config.readinessTimeoutMs).toBe(750);
  });

  it('requires NEO4J_PASSWORD (no secret defaults)', () => {
    expectConfigError({}, 'NEO4J_PASSWORD');
    expectConfigError({ NEO4J_PASSWORD: '' }, 'NEO4J_PASSWORD');
  });

  it.each(['0', '65536', '-1', '3.5', 'abc', ' '])('rejects PORT=%j', (port) => {
    expectConfigError({ ...minimal, PORT: port }, 'PORT');
  });

  it('rejects an unknown log level', () => {
    expectConfigError({ ...minimal, LOG_LEVEL: 'verbose' }, 'LOG_LEVEL');
  });

  it('rejects non-bolt/neo4j URIs and non-redis URLs', () => {
    expectConfigError({ ...minimal, NEO4J_URI: 'http://localhost:7474' }, 'NEO4J_URI');
    expectConfigError({ ...minimal, REDIS_URL: 'http://localhost:6379' }, 'REDIS_URL');
    expectConfigError({ ...minimal, REDIS_URL: 'not a url' }, 'REDIS_URL');
  });

  it('rejects non-positive timeouts', () => {
    expectConfigError({ ...minimal, NEO4J_READ_TIMEOUT_MS: '0' }, 'NEO4J_READ_TIMEOUT_MS');
    expectConfigError({ ...minimal, READINESS_TIMEOUT_MS: '-5' }, 'READINESS_TIMEOUT_MS');
    expectConfigError({ ...minimal, NEO4J_WRITE_TIMEOUT_MS: '0' }, 'NEO4J_WRITE_TIMEOUT_MS');
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ PORT: 'x', LOG_LEVEL: 'loud' });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).problems).toHaveLength(3);
    }
  });

  it('never includes the password in the error message', () => {
    try {
      loadConfig({ NEO4J_PASSWORD: 'hunter2', PORT: 'x' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});
