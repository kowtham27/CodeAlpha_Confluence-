import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive a real browser against the real API, database and
 * Mailpit. Prerequisite: `pnpm infra:up`. The API and web dev servers are
 * started here if they are not already running.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    // Chromium's built-in fake camera (test pattern) and microphone (tone),
    // and no permission prompt: calls can be tested without hardware.
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    permissions: ['camera', 'microphone'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @confluence/api dev',
      cwd: '../..',
      url: 'http://localhost:4000/livez',
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'pnpm --filter @confluence/web dev',
      cwd: '../..',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
