import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function timingSafeSecretMatches(supplied: string | null, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0 || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function hasTimingSafeBearer(request: Request, expected: string): boolean {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const supplied = authorization.slice('Bearer '.length);
  if (!supplied || supplied.includes(' ')) return false;
  return timingSafeSecretMatches(supplied, expected);
}
