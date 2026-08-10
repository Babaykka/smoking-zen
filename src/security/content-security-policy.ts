const OFFICIAL_SUPABASE_HOST = /^[a-z0-9]{20}\.supabase\.co$/u;

function exactHttpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash
      && url.origin === value.replace(/\/$/u, '')
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function trustedSupabaseConnectSources(source: Record<string, string | undefined>): string[] {
  const origin = exactHttpsOrigin(source.SUPABASE_URL);
  if (!origin) return [];
  const hostname = new URL(origin).hostname;
  const explicitSelfHosted = (source.SUPABASE_SELF_HOSTED_ORIGINS ?? '')
    .split(',')
    .map((entry) => exactHttpsOrigin(entry.trim()))
    .filter((entry): entry is string => entry !== null);
  if (!OFFICIAL_SUPABASE_HOST.test(hostname) && !explicitSelfHosted.includes(origin)) return [];
  return [origin, origin.replace(/^https:/u, 'wss:')];
}

export function buildContentSecurityPolicy(
  nonce: string,
  source: Record<string, string | undefined>,
): string {
  const isDevelopment = source.NODE_ENV === 'development';
  const connectSources = ["'self'", ...trustedSupabaseConnectSources(source)].join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://telegram.org${isDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources}`,
    "form-action 'self'",
  ].join('; ');
}
