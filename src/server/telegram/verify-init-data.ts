import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TELEGRAM_ID = 4_503_599_627_370_495n;
const MAX_INIT_DATA_BYTES = 16 * 1_024;
const MAX_FUTURE_SKEW_SECONDS = 30;

export type VerifiedTelegramUser = {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  authDate: number;
};

export class TelegramInitDataError extends Error {
  constructor() {
    super('Telegram authorization is invalid or expired.');
    this.name = 'TelegramInitDataError';
  }
}

function invalid(): never {
  throw new TelegramInitDataError();
}

function parseTelegramId(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) invalid();
    value = String(value);
  }
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) invalid();

  const id = BigInt(value);
  if (id <= 0n || id > MAX_TELEGRAM_ID) invalid();
  return value;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) invalid();
  return value;
}

function parseUser(rawUser: string, authDate: number): VerifiedTelegramUser {
  let value: unknown;
  try {
    value = JSON.parse(rawUser);
  } catch {
    invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();

  const user = value as Record<string, unknown>;
  if (typeof user.first_name !== 'string' || user.first_name.length === 0 || user.first_name.length > 256) invalid();

  return {
    id: parseTelegramId(user.id),
    firstName: user.first_name,
    ...(optionalText(user.last_name, 256) ? { lastName: optionalText(user.last_name, 256) } : {}),
    ...(optionalText(user.username, 64) ? { username: optionalText(user.username, 64) } : {}),
    ...(optionalText(user.language_code, 35) ? { languageCode: optionalText(user.language_code, 35) } : {}),
    authDate,
  };
}

function unixSeconds(now: Date | number): number {
  const milliseconds = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(milliseconds)) invalid();
  return Math.floor(milliseconds / 1_000);
}

export function verifyTelegramInitData(
  raw: string,
  botToken: string,
  now: Date | number = new Date(),
  maxAgeSeconds = 300,
): VerifiedTelegramUser {
  if (
    typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_INIT_DATA_BYTES ||
    typeof botToken !== 'string' || botToken.length === 0 ||
    !Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0
  ) invalid();

  const params = new URLSearchParams(raw);
  const uniqueKeys = new Set<string>();
  for (const [key] of params) {
    if (uniqueKeys.has(key)) invalid();
    uniqueKeys.add(key);
  }

  const receivedHash = params.get('hash');
  const rawAuthDate = params.get('auth_date');
  const rawUser = params.get('user');
  if (!receivedHash || !/^[a-fA-F0-9]{64}$/.test(receivedHash) || !rawAuthDate || !/^\d{1,12}$/.test(rawAuthDate) || !rawUser) {
    invalid();
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const suppliedHash = Buffer.from(receivedHash, 'hex');
  if (!timingSafeEqual(expectedHash, suppliedHash)) invalid();

  const authDate = Number(rawAuthDate);
  const currentSeconds = unixSeconds(now);
  if (
    !Number.isSafeInteger(authDate) || authDate <= 0 ||
    currentSeconds - authDate > maxAgeSeconds ||
    authDate - currentSeconds > MAX_FUTURE_SKEW_SECONDS
  ) invalid();

  return parseUser(rawUser, authDate);
}
