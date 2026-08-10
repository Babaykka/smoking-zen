import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TelegramInitDataError, verifyTelegramInitData } from '@/server/telegram/verify-init-data';

const BOT_TOKEN = '123456:TEST_ONLY_BOT_TOKEN';
const AUTH_DATE_SECONDS = 1_722_513_600;
const VALID_INIT_DATA = new URLSearchParams([
  ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
  ['user', '{"id":4503599627370495,"first_name":"Алина","last_name":"Петрова","username":"alina_zen","language_code":"ru"}'],
  ['auth_date', String(AUTH_DATE_SECONDS)],
  ['hash', 'ff277315c072e32557064cb8a69f7044570beac02f71dfd2dbdcf7d3ad5a3b71'],
]).toString();

function signedInitData(startParam?: string, authDate = AUTH_DATE_SECONDS): string {
  const params = new URLSearchParams([
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['user', '{"id":4503599627370495,"first_name":"Алина","username":"alina_zen"}'],
    ['auth_date', String(authDate)],
  ]);
  if (startParam !== undefined) params.set('start_param', startParam);
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

describe('verifyTelegramInitData', () => {
  it('verifies the official HMAC derivation and preserves a 52-bit Telegram ID as text', () => {
    expect(
      verifyTelegramInitData(
        VALID_INIT_DATA,
        BOT_TOKEN,
        new Date((AUTH_DATE_SECONDS + 60) * 1_000),
        300,
      ),
    ).toEqual({
      id: '4503599627370495',
      firstName: 'Алина',
      lastName: 'Петрова',
      username: 'alina_zen',
      languageCode: 'ru',
      authDate: AUTH_DATE_SECONDS,
    });
  });

  it('rejects a forged signature without disclosing input data', () => {
    const forged = VALID_INIT_DATA.replace(/hash=[^&]+/, `hash=${'0'.repeat(64)}`);

    expect(() => verifyTelegramInitData(forged, BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 60) * 1_000), 300))
      .toThrow(TelegramInitDataError);
    try {
      verifyTelegramInitData(forged, BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 60) * 1_000), 300);
    } catch (error) {
      expect(String(error)).not.toContain('AAHdF6IQAAAAAN0XohDhrOrc');
      expect(String(error)).not.toContain('4503599627370495');
    }
  });

  it.each([
    ['', 'empty input'],
    ['auth_date=1722513600&hash=abc', 'short hash'],
    [`auth_date=1722513600&hash=${'0'.repeat(64)}&hash=${'1'.repeat(64)}&user=%7B%7D`, 'duplicate hash'],
    [`auth_date=not-a-number&hash=${'0'.repeat(64)}&user=%7B%7D`, 'invalid auth date'],
    [`auth_date=1722513600&hash=${'0'.repeat(64)}&user=not-json`, 'invalid user JSON'],
  ])('rejects malformed init data: %s (%s)', (raw) => {
    expect(() => verifyTelegramInitData(raw, BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 60) * 1_000), 300))
      .toThrow(TelegramInitDataError);
  });

  it('rejects stale and materially future-dated init data', () => {
    expect(() => verifyTelegramInitData(VALID_INIT_DATA, BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 301) * 1_000), 300))
      .toThrow('Telegram authorization is invalid or expired.');
    expect(() => verifyTelegramInitData(VALID_INIT_DATA, BOT_TOKEN, new Date((AUTH_DATE_SECONDS - 31) * 1_000), 300))
      .toThrow('Telegram authorization is invalid or expired.');
  });

  it('parses only signed task and 43-character invitation launch intents', () => {
    const taskId = '40000000-0000-4000-8000-000000000001';
    const token = 'A'.repeat(42) + '_';
    expect(verifyTelegramInitData(
      signedInitData(`task_${taskId}`), BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 60) * 1_000), 300,
    )).toMatchObject({ launchIntent: { kind: 'task', taskId } });
    expect(verifyTelegramInitData(
      signedInitData(`invite_${token}`), BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 60) * 1_000), 300,
    )).toMatchObject({ launchIntent: { kind: 'invite', token } });
  });

  it.each([
    'task_not-a-uuid',
    `invite_${'A'.repeat(42)}`,
    `invite_${'A'.repeat(44)}`,
    `invite_${'A'.repeat(42)}+`,
    'unknown_value',
  ])('rejects a signed but invalid start_param: %s', (startParam) => {
    expect(() => verifyTelegramInitData(
      signedInitData(startParam), BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 60) * 1_000), 300,
    )).toThrow(TelegramInitDataError);
  });

  it('rejects a start parameter appended outside the signed initData payload', () => {
    expect(() => verifyTelegramInitData(
      `${VALID_INIT_DATA}&start_param=task_40000000-0000-4000-8000-000000000001`,
      BOT_TOKEN,
      new Date((AUTH_DATE_SECONDS + 60) * 1_000),
      300,
    )).toThrow(TelegramInitDataError);
  });

  it('rejects a correctly signed task start parameter when stale or duplicated', () => {
    const startParam = 'task_40000000-0000-4000-8000-000000000001';
    expect(() => verifyTelegramInitData(
      signedInitData(startParam), BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 301) * 1_000), 300,
    )).toThrow(TelegramInitDataError);

    const duplicate = new URLSearchParams(signedInitData(startParam));
    duplicate.delete('hash');
    duplicate.append('start_param', startParam);
    const check = [...duplicate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    duplicate.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    expect(() => verifyTelegramInitData(
      duplicate.toString(), BOT_TOKEN, new Date((AUTH_DATE_SECONDS + 60) * 1_000), 300,
    )).toThrow(TelegramInitDataError);
  });
});
