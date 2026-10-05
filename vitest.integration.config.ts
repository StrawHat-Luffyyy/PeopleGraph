import { defineConfig } from 'vitest/config';

// Integration tests start real containers with Testcontainers, so they need long
// timeouts and run one file at a time to keep Docker load predictable.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
