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
});
