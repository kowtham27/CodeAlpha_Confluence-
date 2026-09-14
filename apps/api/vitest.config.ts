import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Phase 0 tests are pure/unit. Integration tests that need Postgres and
    // Redis arrive in Phase 1 under a separate `integration` project.
    restoreMocks: true,
  },
});
