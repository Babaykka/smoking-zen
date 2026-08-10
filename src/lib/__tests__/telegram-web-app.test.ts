import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindTelegramBackButton,
  getTelegramInitData,
  initializeTelegramWebApp,
  type TelegramWebApp,
} from '@/lib/telegram-web-app';

function fixture(): TelegramWebApp & { emit(event: string): void } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    initData: 'signed-init-data',
    colorScheme: 'dark',
    themeParams: { bg_color: '#101010', text_color: '#f8f8f8', button_color: '#55aa88' },
    viewportHeight: 720,
    viewportStableHeight: 700,
    safeAreaInset: { top: 12, right: 4, bottom: 20, left: 4 },
    contentSafeAreaInset: { top: 8, right: 0, bottom: 16, left: 0 },
    ready: vi.fn(),
    expand: vi.fn(),
    onEvent: vi.fn((event, listener) => {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
    }),
    offEvent: vi.fn((event, listener) => listeners.get(event)?.delete(listener)),
    emit: (event) => listeners.get(event)?.forEach((listener) => listener()),
  };
}

afterEach(() => {
  document.documentElement.removeAttribute('data-telegram-color-scheme');
  document.documentElement.removeAttribute('style');
  Object.defineProperty(window, 'Telegram', { configurable: true, value: undefined });
});

describe('typed Telegram Web App adapter', () => {
  it('calls ready/expand and mirrors theme, viewport, safe-area, and content-safe-area state', () => {
    const app = fixture();
    const cleanup = initializeTelegramWebApp(app);

    expect(app.ready).toHaveBeenCalledTimes(1);
    expect(app.expand).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.telegramColorScheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--tg-theme-bg-color')).toBe('#101010');
    expect(document.documentElement.style.getPropertyValue('--tg-viewport-height')).toBe('720px');
    expect(document.documentElement.style.getPropertyValue('--tg-viewport-stable-height')).toBe('700px');
    expect(document.documentElement.style.getPropertyValue('--tg-safe-area-inset-bottom')).toBe('20px');
    expect(document.documentElement.style.getPropertyValue('--tg-content-safe-area-inset-bottom')).toBe('16px');

    app.viewportHeight = 640;
    app.safeAreaInset = { top: 1, right: 2, bottom: 30, left: 2 };
    app.emit('viewportChanged');
    app.emit('safeAreaChanged');
    expect(document.documentElement.style.getPropertyValue('--tg-viewport-height')).toBe('640px');
    expect(document.documentElement.style.getPropertyValue('--tg-safe-area-inset-bottom')).toBe('30px');

    cleanup();
    expect(app.offEvent).toHaveBeenCalledWith('themeChanged', expect.any(Function));
    expect(app.offEvent).toHaveBeenCalledWith('contentSafeAreaChanged', expect.any(Function));
  });

  it('reads identity only from the bridge initData field', () => {
    Object.defineProperty(window, 'Telegram', {
      configurable: true,
      value: { WebApp: { ...fixture(), initDataUnsafe: { user: { id: 123 }, start_param: 'forged' } } },
    });
    expect(getTelegramInitData()).toBe('signed-init-data');

    Object.defineProperty(window, 'Telegram', {
      configurable: true,
      value: { WebApp: { initData: '', initDataUnsafe: { user: { id: 123 } } } },
    });
    expect(getTelegramInitData()).toBeNull();
  });

  it('does not touch or warn through the native Back Button on Telegram 6.0', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listener = vi.fn();
    const backButton = {
      show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn(),
    };
    const isVersionAtLeast = vi.fn(() => false);
    Object.defineProperty(window, 'Telegram', {
      configurable: true,
      value: { WebApp: { ...fixture(), version: '6.0', isVersionAtLeast, BackButton: backButton } },
    });

    const cleanup = bindTelegramBackButton(true, listener);
    cleanup();

    expect(isVersionAtLeast).toHaveBeenCalledWith('6.1');
    expect(backButton.onClick).not.toHaveBeenCalled();
    expect(backButton.show).not.toHaveBeenCalled();
    expect(backButton.offClick).not.toHaveBeenCalled();
    expect(backButton.hide).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('shows, invokes, and cleanly unbinds the native Back Button on Telegram 6.1', () => {
    const listener = vi.fn();
    let nativeListener: (() => void) | undefined;
    const isVersionAtLeast = vi.fn(() => true);
    const backButton = {
      show: vi.fn(), hide: vi.fn(),
      onClick: vi.fn((next: () => void) => { nativeListener = next; }),
      offClick: vi.fn(),
    };
    Object.defineProperty(window, 'Telegram', {
      configurable: true,
      value: { WebApp: { ...fixture(), version: '6.1', isVersionAtLeast, BackButton: backButton } },
    });

    const cleanup = bindTelegramBackButton(true, listener);
    expect(isVersionAtLeast).toHaveBeenCalledWith('6.1');
    expect(backButton.show).toHaveBeenCalledTimes(1);
    nativeListener?.();
    expect(listener).toHaveBeenCalledTimes(1);
    cleanup();
    expect(backButton.offClick).toHaveBeenCalledWith(nativeListener);
    expect(backButton.hide).toHaveBeenCalledTimes(1);
  });
});
