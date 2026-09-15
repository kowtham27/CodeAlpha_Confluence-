import { defineConfig } from 'vitest/config';

// Unit tests only. e2e/*.spec.ts belong to Playwright (pnpm test:e2e).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
