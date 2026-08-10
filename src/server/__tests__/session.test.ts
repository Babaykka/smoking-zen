// @vitest-environment node

import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';

import { parseServerEnvironment, ServerConfigurationError } from '@/server/env';

const TEST_PRIVATE_KEY = ['-----BEGIN PRIVATE', ' KEY-----\ntest\n-----END PRIVATE', ' KEY-----'].join('');
import {
  SESSION_COOKIE_NAME,
  clearSession,
  createSession,
  readSession,
  refreshSession,
} from '@/server/session';

const SECRET = 'test-only-session-secret-with-at-least-32-characters';
const NOW = new Date('2026-08-02T10:00:00.000Z');
const IDENTITY = {
  userId: '11111111-1111-4111-8111-111111111111',
  telegramId: '4503599627370495',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  membershipId: '33333333-3333-4333-8333-333333333333',
  role: 'owner' as const,
};

describe('session primitives', () => {
  it('creates a 12-hour HttpOnly SameSite=Lax cookie that is Secure in production', async () => {
    const cookie = await createSession(IDENTITY, { secret: SECRET, now: NOW, secure: true });
    const claims = decodeJwt(cookie.value);

    expect(cookie).toMatchObject({
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
        maxAge: 43_200,
      },
    });
    expect(claims.exp! - claims.iat!).toBe(43_200);
    await expect(readSession(cookie.value, { secret: SECRET, now: new Date(NOW.getTime() + 1_000) }))
      .resolves.toEqual(IDENTITY);
  });

  it('rejects tampered and expired sessions and rotates a valid session identifier on refresh', async () => {
    const cookie = await createSession(IDENTITY, { secret: SECRET, now: NOW, secure: false });
    const tamperedSegments = cookie.value.split('.');
    const signature = tamperedSegments[2]!;
    const changedFirstCharacter = signature[0] === 'A' ? 'B' : 'A';
    tamperedSegments[2] = `${changedFirstCharacter}${signature.slice(1)}`;
    const tamperedSession = tamperedSegments.join('.');
    expect(tamperedSession).not.toBe(cookie.value);
    await expect(readSession(tamperedSession, { secret: SECRET, now: NOW })).resolves.toBeNull();
    await expect(readSession(cookie.value, { secret: SECRET, now: new Date(NOW.getTime() + 43_201_000) }))
      .resolves.toBeNull();

    const refreshed = await refreshSession(cookie.value, {
      secret: SECRET,
      now: new Date(NOW.getTime() + 60_000),
      secure: false,
    });

    expect(refreshed?.value).not.toBe(cookie.value);
    await expect(readSession(refreshed!.value, {
      secret: SECRET,
      now: new Date(NOW.getTime() + 61_000),
    })).resolves.toEqual(IDENTITY);
  });

  it('clears the cookie using the same hardened scope', () => {
    expect(clearSession({ secure: true })).toEqual({
      name: SESSION_COOKIE_NAME,
      value: '',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
        maxAge: 0,
      },
    });
  });
});

describe('server environment', () => {
  it('allows explicit demo mode without credentials', () => {
    expect(parseServerEnvironment({ APP_MODE: 'demo', NODE_ENV: 'development' })).toEqual({
      mode: 'demo',
      production: false,
    });
  });

  it('fails closed when any production credential is missing', () => {
    expect(() => parseServerEnvironment({ APP_MODE: 'production', NODE_ENV: 'production' }))
      .toThrow('Production server configuration is incomplete.');
  });

  it('parses the trusted ES256 signing key and publishable browser configuration in production', () => {
    const environment = parseServerEnvironment({
      APP_MODE: 'production', DEPLOYMENT_ENVIRONMENT: 'production', APP_ORIGIN: 'https://app.example',
      TELEGRAM_BOT_TOKEN: `123456:${'A'.repeat(35)}`, TELEGRAM_BOT_USERNAME: 'smoking_zen_bot',
      TELEGRAM_MINI_APP_SHORT_NAME: 'workspace', TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(32), INTERNAL_JOB_SECRET: 'j'.repeat(32),
      SESSION_SECRET: 's'.repeat(32), SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'service',
      SUPABASE_JWT_ES256_PRIVATE_KEY: TEST_PRIVATE_KEY,
      SUPABASE_JWT_KID: 'trusted-es256-key', OWNER_TELEGRAM_ID: '123456789',
    });

    expect(environment).toMatchObject({
      mode: 'production', supabasePublishableKey: 'sb_publishable_test', supabaseJwtEs256PrivateKey: expect.stringContaining('PRIVATE KEY'), supabaseJwtKid: 'trusted-es256-key',
      bitwardenSelfHostedOrigins: [],
    });
  });

  it('accepts only exact HTTPS origins in the self-hosted Bitwarden allowlist', () => {
    const base = {
      APP_MODE: 'production', DEPLOYMENT_ENVIRONMENT: 'production', APP_ORIGIN: 'https://app.example',
      TELEGRAM_BOT_TOKEN: `123456:${'A'.repeat(35)}`, TELEGRAM_BOT_USERNAME: 'smoking_zen_bot',
      TELEGRAM_MINI_APP_SHORT_NAME: 'workspace', TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(32), INTERNAL_JOB_SECRET: 'j'.repeat(32),
      SESSION_SECRET: 's'.repeat(32), SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'service',
      SUPABASE_JWT_ES256_PRIVATE_KEY: TEST_PRIVATE_KEY,
      SUPABASE_JWT_KID: 'trusted-es256-key', OWNER_TELEGRAM_ID: '123456789',
    };
    expect(parseServerEnvironment({
      ...base, BITWARDEN_SELF_HOSTED_ORIGINS: 'https://vault.example.org, https://vault.company.example',
    })).toMatchObject({ bitwardenSelfHostedOrigins: ['https://vault.example.org', 'https://vault.company.example'] });
    for (const value of ['http://vault.example.org', 'https://vault.example.org/path', 'https://user@vault.example.org', 'https://vault.example.org:8443']) {
      expect(() => parseServerEnvironment({ ...base, BITWARDEN_SELF_HOSTED_ORIGINS: value }))
        .toThrow('Production server configuration is incomplete.');
    }
  });

  it('strictly parses environment-specific Telegram and internal operation identities', () => {
    const source = {
      APP_MODE: 'production', DEPLOYMENT_ENVIRONMENT: 'staging', APP_ORIGIN: 'https://staging.smoking-zen.example',
      TELEGRAM_BOT_TOKEN: `123456:${'A'.repeat(35)}`, TELEGRAM_BOT_USERNAME: 'smoking_zen_staging_bot',
      TELEGRAM_MINI_APP_SHORT_NAME: 'workspace_staging', TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(32),
      INTERNAL_JOB_SECRET: 'j'.repeat(32), SESSION_SECRET: 's'.repeat(32),
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'service',
      SUPABASE_JWT_ES256_PRIVATE_KEY: TEST_PRIVATE_KEY,
      SUPABASE_JWT_KID: 'trusted-es256-key', OWNER_TELEGRAM_ID: '123456789',
    };

    expect(parseServerEnvironment(source)).toMatchObject({
      deploymentEnvironment: 'staging',
      telegramBotUsername: 'smoking_zen_staging_bot',
      telegramMiniAppShortName: 'workspace_staging',
      telegramWebhookSecret: 'w'.repeat(32),
      internalJobSecret: 'j'.repeat(32),
    });
    for (const patch of [
      { DEPLOYMENT_ENVIRONMENT: 'preview' },
      { APP_ORIGIN: 'https://staging.smoking-zen.example/path' },
      { TELEGRAM_BOT_USERNAME: 'not-a-bot' },
      { TELEGRAM_MINI_APP_SHORT_NAME: 'UpperCase' },
      { TELEGRAM_WEBHOOK_SECRET: 'short' },
      { INTERNAL_JOB_SECRET: 'contains whitespace '.repeat(3) },
    ]) {
      expect(() => parseServerEnvironment({ ...source, ...patch })).toThrow(ServerConfigurationError);
    }
  });

  it('binds service-role traffic to an exact Supabase project origin or explicit self-hosted allowlist', () => {
    const source = {
      APP_MODE: 'production', DEPLOYMENT_ENVIRONMENT: 'staging', APP_ORIGIN: 'https://staging.smoking-zen.example',
      TELEGRAM_BOT_TOKEN: `123456:${'A'.repeat(35)}`, TELEGRAM_BOT_USERNAME: 'smoking_zen_staging_bot',
      TELEGRAM_MINI_APP_SHORT_NAME: 'workspace_staging', TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(32),
      INTERNAL_JOB_SECRET: 'j'.repeat(32), SESSION_SECRET: 's'.repeat(32),
      SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'service',
      SUPABASE_JWT_ES256_PRIVATE_KEY: TEST_PRIVATE_KEY,
      SUPABASE_JWT_KID: 'trusted-es256-key', OWNER_TELEGRAM_ID: '123456789',
    };
    for (const value of [
      'http://abcdefghijklmnopqrst.supabase.co',
      'https://short.supabase.co',
      'https://abcdefghijklmnopqrst.supabase.co/path',
      'https://user@abcdefghijklmnopqrst.supabase.co',
      'https://receiver.example',
    ]) expect(() => parseServerEnvironment({ ...source, SUPABASE_URL: value })).toThrow(ServerConfigurationError);

    expect(parseServerEnvironment({
      ...source,
      SUPABASE_URL: 'https://supabase.internal.example',
      SUPABASE_SELF_HOSTED_ORIGINS: 'https://supabase.internal.example',
    })).toMatchObject({ supabaseUrl: 'https://supabase.internal.example' });
    expect(() => parseServerEnvironment({
      ...source,
      SUPABASE_URL: 'https://supabase.internal.example',
      SUPABASE_SELF_HOSTED_ORIGINS: 'https://different.internal.example',
    })).toThrow(ServerConfigurationError);
  });
});
