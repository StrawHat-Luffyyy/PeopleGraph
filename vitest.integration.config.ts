import { defineConfig } from 'vitest/config';

// Integration tests run against real containers (Testcontainers). One Neo4j container is
// started for the whole run in globalSetup and shared; files run one at a time because
// they wipe that shared database between tests.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/support/neo4j.global.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
