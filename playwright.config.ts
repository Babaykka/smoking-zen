import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: /production-runtime\.spec\.ts/u,
  reporter: [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    colorScheme: 'light',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'APP_MODE=demo pnpm dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'], viewport: { width: 360, height: 800 }, deviceScaleFactor: 3 },
    },
    {
      name: 'desktop-dark',
      testMatch: /task8-visual\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
    },
    {
      name: 'telegram-web',
      testMatch: /task8-visual\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-landscape',
      testMatch: /task8-visual\.spec\.ts/u,
      use: { browserName: 'chromium', viewport: { width: 800, height: 360 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
    },
    {
      name: 'ios-webkit',
      testMatch: /task8-visual\.spec\.ts/u,
      use: { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'small-ios-webkit',
      testMatch: /task8-visual\.spec\.ts/u,
      use: { ...devices['iPhone SE'], viewport: { width: 375, height: 667 } },
    },
  ],
});
