// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-nonce': 'request-nonce' }) }));

import RootLayout from '@/app/layout';

describe('Telegram document bridge', () => {
  it('loads the official Web App script in head before application content', async () => {
    const layout = await RootLayout({ children: 'application' });
    const children = Array.isArray(layout.props.children) ? layout.props.children : [layout.props.children];
    const head = children.find((child: { type?: string }) => child?.type === 'head');
    const body = children.find((child: { type?: string }) => child?.type === 'body');
    expect(head?.props.children.type).toBe('script');
    expect(head?.props.children.props).toMatchObject({
      nonce: 'request-nonce',
      src: 'https://telegram.org/js/telegram-web-app.js?63',
      suppressHydrationWarning: true,
    });
    expect(head?.props.children.props).not.toHaveProperty('async');
    expect(head?.props.children.props).not.toHaveProperty('defer');
    expect(body?.props.children).toBe('application');
    expect(layout.props.suppressHydrationWarning).toBe(true);
  });
});
