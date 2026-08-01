import { randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE_NAME = 'smoking_zen_session';
export const SESSION_DURATION_SECONDS = 12 * 60 * 60;

const SESSION_ISSUER = 'smoking-zen';
const SESSION_AUDIENCE = 'smoking-zen-web';

export type SessionIdentity = {
  userId: string;
  telegramId: string;
  workspaceId: string;
  membershipId: string;
  role: 'owner' | 'member';
};

export type SessionCookie = {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: '/';
    maxAge: number;
  };
};

type SessionCryptoOptions = {
  secret: string;
  now?: Date;
};

type SessionCreationOptions = SessionCryptoOptions & {
  secure: boolean;
};

function secretKey(secret: string): Uint8Array {
  if (secret.length < 32) throw new Error('Session configuration is invalid.');
  return Buffer.from(secret, 'utf8');
}

function cookieOptions(secure: boolean, maxAge: number): SessionCookie['options'] {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function identityFromPayload(payload: Record<string, unknown>): SessionIdentity | null {
  if (
    !isUuid(payload.sub) || !isUuid(payload.workspaceId) || !isUuid(payload.membershipId) ||
    typeof payload.telegramId !== 'string' || !/^\d{1,16}$/.test(payload.telegramId) ||
    (payload.role !== 'owner' && payload.role !== 'member')
  ) return null;

  return {
    userId: payload.sub,
    telegramId: payload.telegramId,
    workspaceId: payload.workspaceId,
    membershipId: payload.membershipId,
    role: payload.role,
  };
}

export async function createSession(
  identity: SessionIdentity,
  options: SessionCreationOptions,
): Promise<SessionCookie> {
  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const value = await new SignJWT({
    telegramId: identity.telegramId,
    workspaceId: identity.workspaceId,
    membershipId: identity.membershipId,
    role: identity.role,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(identity.userId)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_DURATION_SECONDS)
    .setJti(randomUUID())
    .sign(secretKey(options.secret));

  return {
    name: SESSION_COOKIE_NAME,
    value,
    options: cookieOptions(options.secure, SESSION_DURATION_SECONDS),
  };
}

export async function readSession(value: string | undefined, options: SessionCryptoOptions): Promise<SessionIdentity | null> {
  if (!value || value.length > 4_096) return null;
  try {
    const verified = await jwtVerify(value, secretKey(options.secret), {
      algorithms: ['HS256'],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      currentDate: options.now,
    });
    return identityFromPayload(verified.payload);
  } catch {
    return null;
  }
}

export async function refreshSession(
  value: string | undefined,
  options: SessionCreationOptions,
): Promise<SessionCookie | null> {
  const identity = await readSession(value, options);
  return identity ? createSession(identity, options) : null;
}

export function clearSession(options: { secure: boolean }): SessionCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: '',
    options: cookieOptions(options.secure, 0),
  };
}
