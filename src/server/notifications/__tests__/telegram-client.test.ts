import { describe, expect, it } from 'vitest';

import {
  createTelegramClient,
  TelegramSendError,
} from '@/server/notifications/telegram-client';

const token = `123456:${'A'.repeat(35)}`;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Telegram notification client', () => {
  it('returns only the safe Telegram message identifier on success', async () => {
    const client = createTelegramClient({
      token,
      fetcher: async () => response(200, {
        ok: true,
        result: { message_id: 321, text: 'server echo that is never returned' },
      }),
    });

    await expect(client.sendMessage({
      chatId: '4503599627370495',
      text: 'Вам назначена задача.',
      taskUrl: 'https://t.me/a_bot/app?startapp=task_40000000-0000-4000-8000-000000000001',
    })).resolves.toEqual({ messageId: 321 });
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a non-positive or unsafe Telegram message identifier: %s',
    async (messageId) => {
      const client = createTelegramClient({
        token,
        fetcher: async () => response(200, { ok: true, result: { message_id: messageId } }),
      });

      await expect(client.sendMessage({
        chatId: '123456789',
        text: 'Вам назначена задача.',
        taskUrl: 'https://t.me/a_bot/app?startapp=task_40000000-0000-4000-8000-000000000001',
      })).rejects.toMatchObject({ code: 'invalid_response', permanent: false });
    },
  );

  it('classifies rate limits with a bounded Telegram retry_after and no response leakage', async () => {
    const sentinel = 'RAW_TELEGRAM_SECRET_SENTINEL';
    const client = createTelegramClient({
      token,
      fetcher: async () => response(429, {
        ok: false,
        description: sentinel,
        parameters: { retry_after: 99_999 },
      }),
    });

    const error = await client.sendMessage({
      chatId: '123456789',
      text: 'Срок задачи наступит в ближайшие 24 часа.',
      taskUrl: 'https://t.me/a_bot/app?startapp=task_40000000-0000-4000-8000-000000000001',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramSendError);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 3_600, permanent: false });
    expect(String(error)).not.toContain(sentinel);
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain('123456789');
  });

  it.each([
    [401, 'configuration_error', true],
    [403, 'recipient_unavailable', true],
    [400, 'recipient_unavailable', true],
    [500, 'telegram_unavailable', false],
    [503, 'telegram_unavailable', false],
    [418, 'invalid_response', false],
  ] as const)('classifies HTTP %s as %s', async (status, code, permanent) => {
    const client = createTelegramClient({
      token,
      fetcher: async () => response(status, { ok: false, description: 'raw response must not escape' }),
    });

    const error = await client.sendMessage({
      chatId: '123456789',
      text: 'У задачи истёк срок.',
      taskUrl: 'https://t.me/a_bot/app?startapp=task_40000000-0000-4000-8000-000000000001',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, permanent });
  });

  it('maps network and malformed configuration failures to enumerated safe errors', async () => {
    const networkClient = createTelegramClient({
      token,
      fetcher: async () => { throw new Error('socket includes secret'); },
    });
    const networkError = await networkClient.sendMessage({
      chatId: '123456789',
      text: 'Вас упомянули в задаче.',
      taskUrl: 'https://t.me/a_bot/app?startapp=task_40000000-0000-4000-8000-000000000001',
    }).catch((caught: unknown) => caught);
    expect(networkError).toMatchObject({ code: 'network_error', permanent: false });
    expect(String(networkError)).not.toContain('socket includes secret');

    const invalidClient = createTelegramClient({ token: 'secret-but-invalid', fetcher: async () => response(200, {}) });
    const configurationError = await invalidClient.sendMessage({
      chatId: '123456789',
      text: 'Вам назначена задача.',
      taskUrl: 'https://t.me/a_bot/app?startapp=task_40000000-0000-4000-8000-000000000001',
    }).catch((caught: unknown) => caught);
    expect(configurationError).toMatchObject({ code: 'configuration_error', permanent: true });
    expect(String(configurationError)).not.toContain('secret-but-invalid');
  });
});
