import { defineConfig, devices } from '@playwright/test';

// The smoke test spawns Vite as a webServer. We keep the footprint small:
// one browser, no parallel workers, short timeout. The seed fixture is
// served at /seed/ and drag-dropped via file uploads.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /^(?!.*mobile\.spec\.ts$).*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
    {
      name: 'iphone14',
      testMatch: /mobile\.spec\.ts$/,
      use: {
        ...devices['iPhone 14'],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
