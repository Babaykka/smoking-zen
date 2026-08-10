// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelegramWebhookHandler, POST } from '@/app/api/telegram/webhook/route';

const SECRET = 'telegram_webhook_secret_32_chars';

function request(body: string, secret?: string) {
  return new Request('https://app.example/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('Telegram webhook route', () => {
  it('verifies the exact secret before parsing the body or writing dedupe state', async () => {
    const store = { recordUpdate: vi.fn() };
    const handler = createTelegramWebhookHandler({ secret: SECRET, requestId: () => 'request-denied', store });
    const denied = request('{"update_id":1,"raw":"BODY_SENTINEL"}', `${SECRET}x`);

    const response = await handler(denied);
    expect(response.status).toBe(401);
    expect(denied.bodyUsed).toBe(false);
    expect(store.recordUpdate).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain('BODY_SENTINEL');
    expect(serialized).not.toContain(SECRET);
  });

  it('caps and validates the webhook envelope before durable deduplication', async () => {
    const store = { recordUpdate: vi.fn() };
    const handler = createTelegramWebhookHandler({ secret: SECRET, requestId: () => 'request-invalid', store });
    const oversized = request(JSON.stringify({ update_id: 1, padding: 'x'.repeat(20_000) }), SECRET);
    oversized.headers.delete('content-length');
    expect((await handler(oversized)).status).toBe(400);
    expect(store.recordUpdate).not.toHaveBeenCalled();
    expect((await handler(request('{"update_id":"1"}', SECRET))).status).toBe(400);
    expect((await handler(request('{"message":{}}', SECRET))).status).toBe(400);
    expect(store.recordUpdate).not.toHaveBeenCalled();
  });

  it('deduplicates allowed private message updates and returns only a generic acknowledgement', async () => {
    const store = { recordUpdate: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const handler = createTelegramWebhookHandler({ secret: SECRET, requestId: () => 'request-message', store });
    const update = JSON.stringify({
      update_id: 123,
      message: { message_id: 9, date: 1_785_744_000, chat: { id: 123456789, type: 'private' }, text: '/start' },
    });

    const first = await handler(request(update, SECRET));
    const duplicate = await handler(request(update, SECRET));
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(store.recordUpdate).toHaveBeenNthCalledWith(1, 123n);
    expect(store.recordUpdate).toHaveBeenNthCalledWith(2, 123n);
    expect(await first.json()).toEqual({ data: { accepted: true }, error: null, requestId: 'request-message' });
    expect(await duplicate.json()).toEqual({ data: { accepted: true }, error: null, requestId: 'request-message' });
  });

  it('durably acknowledges unsupported updates as a safe no-op without interpreting their payload', async () => {
    const store = { recordUpdate: vi.fn().mockResolvedValue(true) };
    const handler = createTelegramWebhookHandler({ secret: SECRET, requestId: () => 'request-noop', store });
    const response = await handler(request(JSON.stringify({
      update_id: 124,
      callback_query: { data: 'DO_NOT_EXECUTE_SENTINEL', from: { id: 123 } },
    }), SECRET));

    expect(response.status).toBe(200);
    expect(store.recordUpdate).toHaveBeenCalledWith(124n);
    expect(JSON.stringify(await response.json())).not.toContain('DO_NOT_EXECUTE_SENTINEL');
  });

  it('durably acknowledges a well-formed group message as an unsupported safe no-op', async () => {
    const store = { recordUpdate: vi.fn().mockResolvedValue(true) };
    const handler = createTelegramWebhookHandler({ secret: SECRET, requestId: () => 'request-group', store });
    const response = await handler(request(JSON.stringify({
      update_id: 125,
      message: { message_id: 10, date: 1_785_744_000, chat: { id: -100123456789, type: 'group' }, text: '/start' },
    }), SECRET));

    expect(response.status).toBe(200);
    expect(store.recordUpdate).toHaveBeenCalledWith(125n);
    expect(await response.json()).toEqual({ data: { accepted: true }, error: null, requestId: 'request-group' });
  });

  it('returns 503 safely when production configuration is incomplete', async () => {
    vi.stubEnv('APP_MODE', 'production');
    const response = await POST(request('{"update_id":1}', SECRET));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ data: null, error: { code: 'service_unavailable' } });
  });
});
