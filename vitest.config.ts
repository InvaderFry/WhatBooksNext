import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/src/**/*.test.ts', 'web/src/**/*.test.ts'],
    // Each test file opens its own in-memory database; files are independent.
    pool: 'threads',
    // Scans now start worker threads that load pdf.js; Windows CI runners need more than the
    // default 5 s for the first one.
    testTimeout: 30_000,
  },
});
