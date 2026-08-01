import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createInviteHandler } from '@/app/api/invites/route';
import { createRedeemInvitationHandler } from '@/app/api/invites/redeem/route';
import { createTelegramSessionHandler } from '@/app/api/session/telegram/route';
import type { SessionCookie } from '@/server/session';
import type { AccessStore, MembershipAccess } from '@/server/supabase';

const NOW = new Date('2026-08-02T10:00:00.000Z');
const OWNER_TELEGRAM_ID = '4503599627370495';
const APP_ORIGIN = 'https://smoking-zen.example';
const COOKIE: SessionCookie = {
  name: '__Host-smoking_zen_session',
  value: 'test-session-token',
  options: { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 43_200 },
};
const OWNER_MEMBERSHIP: MembershipAccess = {
  userId: '11111111-1111-4111-8111-111111111111',
  membershipId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  role: 'owner',
  active: true,
  displayName: 'Алина',
};

function request(path: string, body: unknown, cookie?: string) {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP_ORIGIN,
      ...(cookie ? { cookie: `__Host-smoking_zen_session=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function createStore(overrides: Partial<AccessStore> = {}): AccessStore {
  return {
    bootstrapTelegramUser: async () => OWNER_MEMBERSHIP,
    getActiveMembership: async () => OWNER_MEMBERSHIP,
    createInvitation: async () => ({
      id: '44444444-4444-4444-8444-444444444444',
      expiresAt: '2026-08-03T10:00:00.000Z',
    }),
    redeemInvitation: async () => OWNER_MEMBERSHIP,
    ...overrides,
  };
}

async function json(response: Response) {
  return response.json() as Promise<{
    data: Record<string, unknown> | null;
    error: { code: string; message: string } | null;
    requestId: string;
  }>;
}

describe('Telegram session route', () => {
  it('bootstraps the configured owner idempotently and returns the response envelope', async () => {
    let bootstrapCalls = 0;
    const store = createStore({
      bootstrapTelegramUser: async (input) => {
        bootstrapCalls += 1;
        expect(input.ownerTelegramId).toBe(OWNER_TELEGRAM_ID);
        return OWNER_MEMBERSHIP;
      },
    });
    const handler = createTelegramSessionHandler({
      appOrigin: APP_ORIGIN,
      botToken: 'test-token',
      ownerTelegramId: OWNER_TELEGRAM_ID,
      store,
      now: () => NOW,
      requestId: () => `request-${bootstrapCalls + 1}`,
      verifyInitData: () => ({ id: OWNER_TELEGRAM_ID, firstName: 'Алина', authDate: 1_722_513_600 }),
      createSession: async () => COOKIE,
    });

    const first = await handler(request('/api/session/telegram', { initData: 'signed-init-data' }));
    const second = await handler(request('/api/session/telegram', { initData: 'signed-init-data' }));

    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ data: { membership: OWNER_MEMBERSHIP }, error: null, requestId: 'request-1' });
    expect(second.status).toBe(200);
    expect(bootstrapCalls).toBe(2);
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('denies an inactive membership and never issues a session', async () => {
    let sessionIssued = false;
    const handler = createTelegramSessionHandler({
      appOrigin: APP_ORIGIN,
      botToken: 'test-token',
      ownerTelegramId: OWNER_TELEGRAM_ID,
      store: createStore({ bootstrapTelegramUser: async () => ({ ...OWNER_MEMBERSHIP, active: false }) }),
      now: () => NOW,
      requestId: () => 'request-inactive',
      verifyInitData: () => ({ id: OWNER_TELEGRAM_ID, firstName: 'Алина', authDate: 1_722_513_600 }),
      createSession: async () => {
        sessionIssued = true;
        return COOKIE;
      },
    });

    const response = await handler(request('/api/session/telegram', { initData: 'signed-init-data' }));

    expect(response.status).toBe(403);
    expect(sessionIssued).toBe(false);
    expect(await json(response)).toEqual({
      data: null,
      error: { code: 'membership_inactive', message: 'Доступ к рабочему пространству отключён.' },
      requestId: 'request-inactive',
    });
  });

  it('rejects oversized JSON bodies even when no Content-Length header is supplied', async () => {
    const handler = createTelegramSessionHandler({
      appOrigin: APP_ORIGIN,
      botToken: 'test-token',
      ownerTelegramId: OWNER_TELEGRAM_ID,
      store: createStore(),
      now: () => NOW,
      requestId: () => 'request-oversized',
      verifyInitData: () => ({ id: OWNER_TELEGRAM_ID, firstName: 'Алина', authDate: 1_722_513_600 }),
      createSession: async () => COOKIE,
    });
    const oversized = new Request(`${APP_ORIGIN}/api/session/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
      body: JSON.stringify({ initData: 'signed-init-data', padding: 'x'.repeat(25_000) }),
    });
    oversized.headers.delete('content-length');

    const response = await handler(oversized);

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ data: null, error: { code: 'invalid_request' } });
  });
});

describe('invitation routes', () => {
  it('creates a 24-hour invitation while persisting only a SHA-256 token hash', async () => {
    let storedHash = '';
    const rawToken = 'one-time-invitation-token-that-is-never-stored';
    const handler = createInviteHandler({
      appOrigin: APP_ORIGIN,
      store: createStore({
        createInvitation: async (input) => {
          storedHash = input.tokenHash;
          expect(input.expiresAt).toBe('2026-08-03T10:00:00.000Z');
          return { id: '44444444-4444-4444-8444-444444444444', expiresAt: input.expiresAt };
        },
      }),
      now: () => NOW,
      requestId: () => 'request-invite',
      readSession: async () => OWNER_MEMBERSHIP,
      generateToken: () => rawToken,
    });

    const response = await handler(request('/api/invites', { role: 'member' }, 'owner-session'));
    const body = await json(response);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ data: { token: rawToken, expiresAt: '2026-08-03T10:00:00.000Z' }, error: null });
    expect(storedHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(storedHash).not.toContain(rawToken);
  });

  it('maps transactional single-use and expiry failures to non-disclosing conflicts', async () => {
    for (const code of ['invitation_used', 'invitation_expired'] as const) {
      const handler = createRedeemInvitationHandler({
        appOrigin: APP_ORIGIN,
        botToken: 'test-token',
        store: createStore({
          redeemInvitation: async () => {
            const error = new Error('not available') as Error & { code: string };
            error.code = code;
            throw error;
          },
        }),
        now: () => NOW,
        requestId: () => `request-${code}`,
        verifyInitData: () => ({ id: '123456789', firstName: 'Иван', authDate: 1_722_513_600 }),
        createSession: async () => COOKIE,
      });

      const response = await handler(request('/api/invites/redeem', {
        initData: 'signed-init-data',
        token: 'already-used-or-expired-secret-token',
      }));

      expect(response.status).toBe(409);
      expect(JSON.stringify(await json(response))).not.toContain('already-used-or-expired-secret-token');
    }
  });
});
