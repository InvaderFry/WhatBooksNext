import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/src/**/*.test.ts', 'web/src/**/*.test.ts'],
    // Each test file opens its own in-memory database; files are independent.
    pool: 'threads',
  },
});
