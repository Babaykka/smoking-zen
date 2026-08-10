// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';

import Home from '@/app/page';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('Home browser configuration boundary', () => {
  it('serializes only a validated publishable key and a server-configured Telegram launch URL', () => {
    process.env = {
      ...originalEnvironment,
      APP_MODE: 'production',
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_server',
      TELEGRAM_BOT_USERNAME: 'smoking_zen_bot',
      TELEGRAM_MINI_APP_SHORT_NAME: 'workspace',
    };

    const page = Home();
    expect(page.props.productionConfig).toEqual({
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      supabasePublishableKey: 'sb_publishable_browser',
      telegramLaunchUrl: 'https://t.me/smoking_zen_bot/workspace',
    });
  });

  it.each([
    { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_server' },
    { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_same', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_same' },
    { SUPABASE_URL: 'https://receiver.example' },
  ])('fails closed before a dangerous browser value reaches React props', (patch) => {
    process.env = {
      ...originalEnvironment,
      APP_MODE: 'production',
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_browser',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_server',
      ...patch,
    };

    const page = Home();
    expect(page.props.productionConfig).toBeUndefined();
    expect(JSON.stringify(page.props)).not.toContain(String(process.env.SUPABASE_PUBLISHABLE_KEY));
  });
});
