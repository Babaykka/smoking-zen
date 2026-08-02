import { NextResponse } from 'next/server';

import { SESSION_COOKIE_NAME, type SessionCookie } from '@/server/session';

export type ApiError = { code: string; message: string };
export type ApiEnvelope<T> = { data: T | null; error: ApiError | null; requestId: string };
export const DEFAULT_MAX_JSON_BYTES = 20_000;
export const WORKSPACE_MAX_JSON_BYTES = 128 * 1024;

export function apiResponse<T>(
  requestId: string,
  status: number,
  data: T | null,
  error: ApiError | null,
): NextResponse<ApiEnvelope<T>> {
  const response = NextResponse.json({ data, error, requestId }, { status });
  response.headers.set('cache-control', 'no-store');
  return response;
}

export function setSessionCookie(response: NextResponse, cookie: SessionCookie): void {
  response.cookies.set(cookie.name, cookie.value, cookie.options);
}

export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === SESSION_COOKIE_NAME) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function hasSameOrigin(request: Request, expectedOrigin: string): boolean {
  const suppliedOrigin = request.headers.get('origin');
  if (!suppliedOrigin) return false;
  try {
    return new URL(suppliedOrigin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

export async function readJsonObject(
  request: Request,
  maximumBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<Record<string, unknown> | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > maximumBytes) return null;
  if (!request.body) return null;

  try {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let raw = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        return null;
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
