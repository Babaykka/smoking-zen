import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /production-runtime\.spec\.ts/u,
  reporter: 'line',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3101',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: [
      'APP_MODE=production',
      'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co',
      'SUPABASE_PUBLISHABLE_KEY=sb_publishable_local',
      'TELEGRAM_BOT_USERNAME=smoking_zen_bot',
      'TELEGRAM_MINI_APP_SHORT_NAME=workspace',
      'pnpm exec next start --hostname 127.0.0.1 --port 3101',
    ].join(' '),
    url: 'http://127.0.0.1:3101',
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{
    name: 'production-chromium',
    use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
  }],
});
