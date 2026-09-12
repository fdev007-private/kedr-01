import { defineConfig, devices } from '@playwright/test';

const externalURL = process.env.PLAYWRIGHT_BASE_URL;
const basePath = process.env.PAGES_BASE_PATH || '/';
const baseURL = externalURL || new URL(basePath, 'http://127.0.0.1:4173').href;
const server = process.env.PLAYWRIGHT_PREVIEW === 'true' ? 'preview' : 'dev';

export default defineConfig({
  testDir: './tests',
  testMatch: 'site.spec.js',
  fullyParallel: true,
  workers: 2,
  timeout: 40_000,
  use: { baseURL, channel: process.env.CI ? undefined : 'chrome', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: externalURL
    ? undefined
    : {
        command: `npm run ${server} -- --port 4173 --strictPort --base=${basePath}`,
        url: baseURL,
        reuseExistingServer: false,
      },
});
