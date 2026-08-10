// @vitest-environment node

import { describe, expect, it } from 'vitest';

import nextConfig from '../../../next.config';
import { config as proxyConfig } from '../../proxy';
import { buildContentSecurityPolicy, trustedSupabaseConnectSources } from '@/security/content-security-policy';

describe('document security headers', () => {
  it('does not advertise the application framework', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('allows Telegram Web framing while restricting scripts and network destinations', async () => {
    expect(nextConfig.headers).toBeTypeOf('function');
    const rules = await nextConfig.headers!();
    const root = rules.find((rule) => rule.source === '/(.*)');
    const headers = new Map(root?.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    const csp = buildContentSecurityPolicy('request-nonce', {
      NODE_ENV: 'production', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    });

    expect(headers.has('x-frame-options')).toBe(false);
    expect(headers.has('content-security-policy')).toBe(false);
    expect(csp).toContain("frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
    const scriptDirective = csp.split('; ').find((directive) => directive.startsWith('script-src')) ?? '';
    expect(scriptDirective).toContain("script-src 'self' 'nonce-request-nonce' 'strict-dynamic'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(csp).toContain('https://telegram.org');
    expect(csp).toContain('https://abcdefghijklmnopqrst.supabase.co');
    expect(csp).toContain('wss://abcdefghijklmnopqrst.supabase.co');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('allows only the exact configured self-hosted Supabase HTTPS/WSS origin', () => {
    const source = {
      SUPABASE_URL: 'https://supabase.internal.example',
      SUPABASE_SELF_HOSTED_ORIGINS: 'https://supabase.internal.example',
    };
    expect(trustedSupabaseConnectSources(source)).toEqual([
      'https://supabase.internal.example', 'wss://supabase.internal.example',
    ]);
    expect(trustedSupabaseConnectSources({
      ...source, SUPABASE_SELF_HOSTED_ORIGINS: 'https://other.internal.example',
    })).toEqual([]);
  });

  it('does not exempt API or navigation-prefetch responses from the CSP proxy', () => {
    expect(proxyConfig.matcher[0]!.source).not.toContain('api|');
    expect(proxyConfig.matcher[0]).not.toHaveProperty('missing');
  });
});
