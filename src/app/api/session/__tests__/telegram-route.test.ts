import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createInviteHandler } from '@/app/api/invites/route';
import { createRedeemInvitationHandler } from '@/app/api/invites/redeem/route';
import { createRefreshSessionHandler } from '@/app/api/session/refresh/route';
import { createTelegramSessionHandler } from '@/app/api/session/telegram/route';
import { SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS, type SessionCookie } from '@/server/session';
import { readSessionCookie } from '@/server/http';
import type { AccessStore, MembershipAccess } from '@/server/supabase';

const NOW = new Date('2026-08-02T10:00:00.000Z');
const OWNER_TELEGRAM_ID = '4503599627370495';
const APP_ORIGIN = 'https://smoking-zen.example';
const COOKIE: SessionCookie = {
  name: SESSION_COOKIE_NAME,
  value: 'test-session-token',
  options: { httpOnly: true, sameSite: 'none', secure: true, partitioned: true, path: '/', maxAge: 43_200 },
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
      ...(cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function createStore(overrides: Partial<AccessStore> = {}): AccessStore {
  return {
    consumeTelegramSessionAttempt: async () => true,
    bootstrapTelegramUser: async () => OWNER_MEMBERSHIP,
    getActiveMembership: async () => OWNER_MEMBERSHIP,
    createInvitation: async () => ({
      id: '44444444-4444-4444-8444-444444444444',
      expiresAt: '2026-08-03T10:00:00.000Z',
    }),
    redeemInvitation: async () => OWNER_MEMBERSHIP,
    getAuthorizedTaskLaunch: async (_userId, _workspaceId, _membershipId, taskId) => ({ taskId }),
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
    const setCookie = first.headers.get('set-cookie') ?? '';
    expect(setCookie.split(';').map((part) => part.trim())).toEqual(expect.arrayContaining([
      `${SESSION_COOKIE_NAME}=test-session-token`,
      'Path=/',
      `Max-Age=${SESSION_DURATION_SECONDS}`,
      'Secure',
      'Partitioned',
      'HttpOnly',
      'SameSite=none',
    ]));
    expect(readSessionCookie(request('/api/tasks', {}, 'parsed-session-token'))).toBe('parsed-session-token');
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

  it('redeems only the invitation token carried inside verified initData and issues one session', async () => {
    const token = 'A'.repeat(42) + '_';
    let bootstrapCalls = 0;
    let redeemedHash = '';
    const handler = createTelegramSessionHandler({
      appOrigin: APP_ORIGIN,
      botToken: 'test-token',
      ownerTelegramId: OWNER_TELEGRAM_ID,
      store: createStore({
        bootstrapTelegramUser: async () => { bootstrapCalls += 1; return null; },
        redeemInvitation: async (input) => {
          redeemedHash = input.tokenHash;
          return { ...OWNER_MEMBERSHIP, role: 'member' };
        },
      }),
      now: () => NOW,
      requestId: () => 'request-signed-invite',
      verifyInitData: () => ({
        id: '123456789', firstName: 'Иван', authDate: 1_722_513_600,
        launchIntent: { kind: 'invite', token },
      }),
      createSession: async () => COOKIE,
    });

    const response = await handler(request('/api/session/telegram', { initData: 'signed-init-data-only' }));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      data: { membership: { role: 'member' }, launch: null }, error: null,
    });
    expect(redeemedHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(bootstrapCalls).toBe(0);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it.each(['invitation_invalid', 'invitation_used', 'invitation_expired'] as const)(
    'fails a signed unavailable invitation generically: %s',
    async (code) => {
      const token = 'B'.repeat(43);
      const handler = createTelegramSessionHandler({
        appOrigin: APP_ORIGIN,
        botToken: 'test-token',
        ownerTelegramId: OWNER_TELEGRAM_ID,
        store: createStore({
          redeemInvitation: async () => {
            const error = new Error(`raw-${code}-sentinel`) as Error & { code: string };
            error.code = code;
            throw error;
          },
        }),
        now: () => NOW,
        requestId: () => 'request-unavailable-invite',
        verifyInitData: () => ({
          id: '123456789', firstName: 'Иван', authDate: 1_722_513_600,
          launchIntent: { kind: 'invite', token },
        }),
        createSession: async () => COOKIE,
      });

      const response = await handler(request('/api/session/telegram', { initData: 'signed-init-data-only' }));
      const serialized = JSON.stringify(await json(response));
      expect(response.status).toBe(409);
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(token);
      expect(response.headers.get('set-cookie')).toBeNull();
    },
  );

  it('returns only an authorized task directive from the signed start parameter', async () => {
    const taskId = '40000000-0000-4000-8000-000000000001';
    const handler = createTelegramSessionHandler({
      appOrigin: APP_ORIGIN,
      botToken: 'test-token',
      ownerTelegramId: OWNER_TELEGRAM_ID,
      store: createStore({
        getAuthorizedTaskLaunch: async (userId, workspaceId, membershipId, requestedTaskId) => {
          expect([userId, workspaceId, membershipId, requestedTaskId]).toEqual([
            OWNER_MEMBERSHIP.userId, OWNER_MEMBERSHIP.workspaceId, OWNER_MEMBERSHIP.membershipId, taskId,
          ]);
          return { taskId };
        },
      }),
      now: () => NOW,
      requestId: () => 'request-task-launch',
      verifyInitData: () => ({
        id: OWNER_TELEGRAM_ID, firstName: 'Алина', authDate: 1_722_513_600,
        launchIntent: { kind: 'task', taskId },
      }),
      createSession: async () => COOKIE,
    });

    const response = await handler(request('/api/session/telegram', { initData: 'signed-init-data-only' }));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ data: { launch: { kind: 'task', taskId } } });
  });

  it('rejects a cross-workspace task and any caller-supplied unsigned launch field', async () => {
    let verifyCalls = 0;
    const taskId = '40000000-0000-4000-8000-000000000099';
    const dependencies = {
      appOrigin: APP_ORIGIN,
      botToken: 'test-token',
      ownerTelegramId: OWNER_TELEGRAM_ID,
      store: createStore({ getAuthorizedTaskLaunch: async () => null }),
      now: () => NOW,
      requestId: () => 'request-cross-workspace',
      verifyInitData: () => {
        verifyCalls += 1;
        return {
          id: OWNER_TELEGRAM_ID, firstName: 'Алина', authDate: 1_722_513_600,
          launchIntent: { kind: 'task' as const, taskId },
        };
      },
      createSession: async () => COOKIE,
    };
    const handler = createTelegramSessionHandler(dependencies);

    const crossWorkspace = await handler(request('/api/session/telegram', { initData: 'signed-init-data-only' }));
    expect(crossWorkspace.status).toBe(403);
    expect(crossWorkspace.headers.get('set-cookie')).toBeNull();

    const unsigned = await handler(request('/api/session/telegram', {
      initData: 'signed-init-data-without-launch',
      startParam: `task_${taskId}`,
    }));
    expect(unsigned.status).toBe(400);
    expect(verifyCalls).toBe(1);
  });

  it('rate-limits only after signed identity verification and before any membership write', async () => {
    let verified = 0;
    let bootstrapped = 0;
    const consume = async (telegramId: string) => {
      expect(telegramId).toBe('123456789');
      return false;
    };
    const handler = createTelegramSessionHandler({
      appOrigin: APP_ORIGIN,
      botToken: 'test-token',
      ownerTelegramId: OWNER_TELEGRAM_ID,
      store: {
        ...createStore({ bootstrapTelegramUser: async () => { bootstrapped += 1; return null; } }),
        consumeTelegramSessionAttempt: consume,
      } as never,
      now: () => NOW,
      requestId: () => 'request-rate-limited',
      verifyInitData: () => {
        verified += 1;
        return { id: '123456789', firstName: 'Новый', authDate: 1_722_513_600 };
      },
      createSession: async () => COOKIE,
    });

    const response = await handler(request('/api/session/telegram', { initData: 'signed-init-data' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(verified).toBe(1);
    expect(bootstrapped).toBe(0);
  });
});

describe('invitation routes', () => {
  it('rejects wrong methods before parsing, authentication, or persistence', async () => {
    let effects = 0;
    const invite = createInviteHandler({
      appOrigin: APP_ORIGIN,
      botUsername: 'smoking_zen_bot',
      appShortName: 'workspace',
      store: createStore({ getActiveMembership: async () => { effects += 1; return OWNER_MEMBERSHIP; } }),
      now: () => NOW,
      requestId: () => 'request-invite-method',
      readSession: async () => { effects += 1; return OWNER_MEMBERSHIP; },
      generateToken: () => { effects += 1; return 'A'.repeat(43); },
    });
    const telegram = createTelegramSessionHandler({
      appOrigin: APP_ORIGIN,
      botToken: 'test-token', ownerTelegramId: OWNER_TELEGRAM_ID, workspaceName: 'Smoking Zen',
      maxAgeSeconds: 300, now: () => NOW, requestId: () => 'request-session-method',
      store: createStore({ bootstrapTelegramUser: async () => { effects += 1; return OWNER_MEMBERSHIP; } }),
      verifyInitData: () => { effects += 1; return { id: '123456789', firstName: 'Новый', authDate: 1_722_513_600 }; },
      createSession: async () => COOKIE,
    });

    for (const handler of [invite, telegram]) {
      const response = await handler(new Request(`${APP_ORIGIN}/wrong-method`, { method: 'GET' }));
      expect(response.status).toBe(405);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect((await json(response)).error?.code).toBe('method_not_allowed');
    }
    expect(effects).toBe(0);
  });

  it('creates a 24-hour invitation while persisting only a SHA-256 token hash', async () => {
    let storedHash = '';
    const rawToken = 'A'.repeat(42) + '_';
    const handler = createInviteHandler({
      appOrigin: APP_ORIGIN,
      botUsername: 'smoking_zen_bot',
      appShortName: 'workspace',
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
    expect(body).toMatchObject({
      data: {
        inviteLink: `https://t.me/smoking_zen_bot/workspace?startapp=invite_${rawToken}`,
        expiresAt: '2026-08-03T10:00:00.000Z',
      },
      error: null,
    });
    expect(body.data).not.toHaveProperty('token');
    expect(storedHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(storedHash).not.toContain(rawToken);
  });

  it('closes the unsigned separate invitation redemption endpoint without reading its body or causing effects', async () => {
    let effects = 0;
    const handler = createRedeemInvitationHandler({
      requestId: () => 'request-removed-redeem',
      onEffect: () => { effects += 1; },
    });
    const wrongMethod = await handler(new Request(`${APP_ORIGIN}/api/invites/redeem`, { method: 'GET' }));
    expect(wrongMethod.status).toBe(405);
    const unsafe = request('/api/invites/redeem', {
      initData: 'signed-init-data', token: 'caller-controlled-token',
    });

    const response = await handler(unsafe);
    expect(response.status).toBe(410);
    expect(unsafe.bodyUsed).toBe(false);
    expect(effects).toBe(0);
    expect(JSON.stringify(await json(response))).not.toContain('caller-controlled-token');
  });
});

describe('session refresh route', () => {
  it('rejects wrong methods before session or store work and clears an invalid POST session', async () => {
    let effects = 0;
    const handler = createRefreshSessionHandler({
      appOrigin: APP_ORIGIN,
      store: createStore({ getActiveMembership: async () => { effects += 1; return OWNER_MEMBERSHIP; } }),
      requestId: () => 'request-refresh',
      readSession: async () => { effects += 1; return null; },
      refreshSession: async () => { effects += 1; return COOKIE; },
      clearSession: () => ({ ...COOKIE, value: '', options: { ...COOKIE.options, maxAge: 0 } }),
    });

    const wrongMethod = await handler(new Request(`${APP_ORIGIN}/api/session/refresh`, { method: 'GET' }));
    expect(wrongMethod.status).toBe(405);
    expect(effects).toBe(0);

    const invalid = await handler(request('/api/session/refresh', {}));
    expect(invalid.status).toBe(401);
    expect(effects).toBe(1);
    expect(invalid.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
  });
});
