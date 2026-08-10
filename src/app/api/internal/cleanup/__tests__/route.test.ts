// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCleanupHandler, POST } from '@/app/api/internal/cleanup/route';

const SECRET = 'internal-cleanup-secret-32-characters';
const RESULT = {
  staged: 1, fileCandidates: 1, fileRemoved: 1, orphanDiscovered: 0,
  orphanCandidates: 0, orphanRemoved: 0, pending: 0, failed: 0, purged: 2,
};

function request(body: string, authorization?: string) {
  return new Request('https://app.example/api/internal/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('internal cleanup route', () => {
  it('authenticates exact Bearer before reading body or causing effects', async () => {
    const run = vi.fn();
    const handler = createCleanupHandler({ secret: SECRET, requestId: () => 'denied', run });
    const denied = request('{"secret":"RAW_BODY_SENTINEL"}', `Bearer ${SECRET}x`);
    const response = await handler(denied);
    expect(response.status).toBe(401);
    expect(denied.bodyUsed).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('RAW_BODY_SENTINEL');
  });

  it('accepts only {}, calls fixed execution with no arguments, and returns no-store', async () => {
    const run = vi.fn().mockResolvedValue(RESULT);
    const response = await createCleanupHandler({ secret: SECRET, requestId: () => 'ok', run })(
      request('{}', `Bearer ${SECRET}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ data: RESULT, error: null, requestId: 'ok' });
    expect(run).toHaveBeenCalledWith();
  });

  it.each([
    { clock: '2026-01-01T00:00:00Z' }, { workspaceId: ID }, { path: ID },
    { url: 'https://evil.example' }, { batch: 100 }, { recipientId: ID },
  ])('rejects caller-controlled cleanup input: %j', async (body) => {
    const run = vi.fn();
    const response = await createCleanupHandler({ secret: SECRET, requestId: () => 'bad', run })(
      request(JSON.stringify(body), `Bearer ${SECRET}`),
    );
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies and safely redacts failures', async () => {
    const run = vi.fn().mockRejectedValue(new Error('CLEANUP_SECRET_SENTINEL'));
    const handler = createCleanupHandler({ secret: SECRET, requestId: () => 'failed', run });
    expect((await handler(request(JSON.stringify({ padding: 'x'.repeat(1_000) }), `Bearer ${SECRET}`))).status).toBe(400);
    const response = await handler(request('{}', `Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('CLEANUP_SECRET_SENTINEL');
  });

  it('returns 503 when production configuration is incomplete', async () => {
    vi.stubEnv('APP_MODE', 'production');
    const response = await POST(request('{}', `Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

const ID = '11111111-1111-4111-8111-111111111111';
