// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReminderHandler, POST } from '@/app/api/internal/reminders/route';

const SECRET = 'r'.repeat(32);
const result = {
  planned: 2, claimed: 2, delivered: 1, retried: 0,
  deadLettered: 0, suppressed: 1, indeterminate: 0,
};

function request(body: string, authorization?: string, method = 'POST') {
  return new Request('https://app.example/api/internal/reminders', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('internal reminder route', () => {
  it('authenticates the exact Bearer secret before reading a request body or causing effects', async () => {
    let runs = 0;
    const handler = createReminderHandler({
      secret: SECRET,
      requestId: () => 'request-denied',
      run: async () => { runs += 1; return result; },
    });
    const denied = request('{"clock":"2026-01-01","secret":"RAW_BODY_SENTINEL"}', `Bearer ${SECRET}x`);

    const response = await handler(denied);
    expect(response.status).toBe(401);
    expect(denied.bodyUsed).toBe(false);
    expect(runs).toBe(0);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('RAW_BODY_SENTINEL');
  });

  it('runs with fixed server scope and accepts only an empty object without cookie or Origin', async () => {
    const run = vi.fn().mockResolvedValue(result);
    const handler = createReminderHandler({ secret: SECRET, requestId: () => 'request-ok', run });
    const response = await handler(request('{}', `Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: result, error: null, requestId: 'request-ok' });
    expect(run).toHaveBeenCalledWith();
  });

  it.each([
    { clock: '2026-08-02T10:00:00Z' },
    { workspaceId: '33333333-3333-4333-8333-333333333333' },
    { recipientId: '22222222-2222-4222-8222-222222222222' },
    { url: 'https://evil.example' },
    { batch: 100 },
  ])('rejects caller-controlled planner input: %j', async (body) => {
    const run = vi.fn();
    const handler = createReminderHandler({ secret: SECRET, requestId: () => 'request-fields', run });
    const response = await handler(request(JSON.stringify(body), `Bearer ${SECRET}`));
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies and reports a post-send indeterminate cycle as unavailable', async () => {
    const run = vi.fn().mockResolvedValue({ ...result, indeterminate: 1 });
    const handler = createReminderHandler({ secret: SECRET, requestId: () => 'request-indeterminate', run });
    const oversized = request(JSON.stringify({ padding: 'x'.repeat(1_000) }), `Bearer ${SECRET}`);
    oversized.headers.delete('content-length');
    expect((await handler(oversized)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();

    const indeterminate = await handler(request('{}', `Bearer ${SECRET}`));
    expect(indeterminate.status).toBe(503);
    expect(await indeterminate.json()).toMatchObject({
      data: { ...result, indeterminate: 1 },
      error: { code: 'delivery_indeterminate' },
    });
  });

  it('returns 503 safely when production configuration is incomplete', async () => {
    vi.stubEnv('APP_MODE', 'production');
    const response = await POST(request('{}', `Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ data: null, error: { code: 'service_unavailable' } });
  });
});
