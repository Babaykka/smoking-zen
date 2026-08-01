// @vitest-environment node

import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { createRealtimeAccessToken } from '@/server/realtime-token';
import { createRealtimeTokenHandler } from '@/app/api/realtime/token/route';

describe('Realtime access token', () => {
  it('mints a short-lived ES256 Supabase user JWT with the trusted kid and workspace claim', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);
    const now = new Date('2026-08-02T10:00:00.000Z');
    const token = await createRealtimeAccessToken({
      userId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '33333333-3333-4333-8333-333333333333',
    }, {
      privateKeyPem,
      keyId: 'supabase-es256-key-1',
      issuer: 'https://project.supabase.co/auth/v1',
      now,
    });

    const verified = await jwtVerify(token, publicKey, { algorithms: ['ES256'], audience: 'authenticated', issuer: 'https://project.supabase.co/auth/v1', currentDate: now });
    expect(verified.protectedHeader).toMatchObject({ alg: 'ES256', kid: 'supabase-es256-key-1', typ: 'JWT' });
    expect(verified.payload).toMatchObject({ sub: '11111111-1111-4111-8111-111111111111', role: 'authenticated', workspace_id: '33333333-3333-4333-8333-333333333333' });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(300);
  });
});

describe('Realtime token route', () => {
  it('fails closed without a valid active session and returns only a short-lived token after authentication', async () => {
    const anonymous = createRealtimeTokenHandler({ authenticate: async () => null, mint: async () => 'never', now: () => new Date('2026-08-02T10:00:00.000Z'), requestId: () => 'anonymous' });
    expect((await anonymous(new Request('https://app.example/api/realtime/token'))).status).toBe(401);

    const actor = { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '33333333-3333-4333-8333-333333333333', membershipId: '22222222-2222-4222-8222-222222222222' };
    const authenticated = createRealtimeTokenHandler({ authenticate: async () => actor, mint: async () => 'signed-es256-token', now: () => new Date('2026-08-02T10:00:00.000Z'), requestId: () => 'authenticated' });
    const response = await authenticated(new Request('https://app.example/api/realtime/token'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { token: 'signed-es256-token', workspaceId: actor.workspaceId, expiresAt: '2026-08-02T10:05:00.000Z' }, error: null, requestId: 'authenticated',
    });
  });
});
