// @vitest-environment node

import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';

import { parseServerEnvironment } from '@/server/env';
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
    await expect(readSession(`${cookie.value.slice(0, -1)}x`, { secret: SECRET, now: NOW })).resolves.toBeNull();
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
      APP_MODE: 'production', APP_ORIGIN: 'https://app.example', TELEGRAM_BOT_TOKEN: 'bot-token',
      SESSION_SECRET: 's'.repeat(32), SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'service',
      SUPABASE_JWT_ES256_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
      SUPABASE_JWT_KID: 'trusted-es256-key', OWNER_TELEGRAM_ID: '123456789',
    });

    expect(environment).toMatchObject({
      mode: 'production', supabasePublishableKey: 'sb_publishable_test', supabaseJwtEs256PrivateKey: expect.stringContaining('PRIVATE KEY'), supabaseJwtKid: 'trusted-es256-key',
    });
  });
});
