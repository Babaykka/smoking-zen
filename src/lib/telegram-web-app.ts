'use client';

export type TelegramInsets = { top: number; right: number; bottom: number; left: number };
export type TelegramWebAppEvent = 'themeChanged' | 'viewportChanged' | 'safeAreaChanged' | 'contentSafeAreaChanged';

export type TelegramBackButton = {
  isVisible?: boolean;
  show?(): void;
  hide?(): void;
  onClick?(listener: () => void): void;
  offClick?(listener: () => void): void;
};

export type TelegramWebApp = {
  initData: string;
  version?: string;
  isVersionAtLeast?(version: string): boolean;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string | undefined>;
  viewportHeight?: number;
  viewportStableHeight?: number;
  safeAreaInset?: TelegramInsets;
  contentSafeAreaInset?: TelegramInsets;
  BackButton?: TelegramBackButton;
  ready?(): void;
  expand?(): void;
  onEvent?(event: TelegramWebAppEvent, listener: () => void): void;
  offEvent?(event: TelegramWebAppEvent, listener: () => void): void;
};

type TelegramWindow = Window & { Telegram?: { WebApp?: unknown } };

const THEME_VARIABLES: Record<string, string> = {
  bg_color: '--tg-theme-bg-color',
  secondary_bg_color: '--tg-theme-secondary-bg-color',
  text_color: '--tg-theme-text-color',
  hint_color: '--tg-theme-hint-color',
  link_color: '--tg-theme-link-color',
  button_color: '--tg-theme-button-color',
  button_text_color: '--tg-theme-button-text-color',
  header_bg_color: '--tg-theme-header-bg-color',
  accent_text_color: '--tg-theme-accent-text-color',
  section_bg_color: '--tg-theme-section-bg-color',
  section_header_text_color: '--tg-theme-section-header-text-color',
  subtitle_text_color: '--tg-theme-subtitle-text-color',
  destructive_text_color: '--tg-theme-destructive-text-color',
};

function safePixels(value: unknown): string {
  return `${typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0}px`;
}

function applyInsets(root: HTMLElement, prefix: string, insets: TelegramInsets | undefined) {
  root.style.setProperty(`${prefix}-top`, safePixels(insets?.top));
  root.style.setProperty(`${prefix}-right`, safePixels(insets?.right));
  root.style.setProperty(`${prefix}-bottom`, safePixels(insets?.bottom));
  root.style.setProperty(`${prefix}-left`, safePixels(insets?.left));
}

function applyTelegramState(webApp: TelegramWebApp, root: HTMLElement) {
  if (webApp.colorScheme === 'light' || webApp.colorScheme === 'dark') {
    root.dataset.telegramColorScheme = webApp.colorScheme;
  }
  for (const [key, cssVariable] of Object.entries(THEME_VARIABLES)) {
    const value = webApp.themeParams?.[key];
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)) root.style.setProperty(cssVariable, value);
  }
  root.style.setProperty('--tg-viewport-height', safePixels(webApp.viewportHeight));
  root.style.setProperty('--tg-viewport-stable-height', safePixels(webApp.viewportStableHeight));
  applyInsets(root, '--tg-safe-area-inset', webApp.safeAreaInset);
  applyInsets(root, '--tg-content-safe-area-inset', webApp.contentSafeAreaInset);
}

export function getTelegramWebApp(target: Window = window): TelegramWebApp | null {
  const candidate = (target as TelegramWindow).Telegram?.WebApp;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const initData = (candidate as Record<string, unknown>).initData;
  if (typeof initData !== 'string') return null;
  return candidate as TelegramWebApp;
}

export function getTelegramInitData(target: Window = window): string | null {
  const initData = getTelegramWebApp(target)?.initData;
  return typeof initData === 'string' && initData.length > 0 ? initData : null;
}

export function initializeTelegramWebApp(
  webApp = getTelegramWebApp(),
  root: HTMLElement = document.documentElement,
): () => void {
  if (!webApp) return () => undefined;
  const update = () => applyTelegramState(webApp, root);
  const events: TelegramWebAppEvent[] = [
    'themeChanged', 'viewportChanged', 'safeAreaChanged', 'contentSafeAreaChanged',
  ];
  update();
  for (const event of events) webApp.onEvent?.(event, update);
  webApp.ready?.();
  webApp.expand?.();
  return () => {
    for (const event of events) webApp.offEvent?.(event, update);
  };
}

export function bindTelegramBackButton(active: boolean, onBack: () => void): () => void {
  const webApp = getTelegramWebApp();
  if (!webApp || !active || typeof webApp.version !== 'string' || webApp.isVersionAtLeast?.('6.1') !== true) {
    return () => undefined;
  }
  const button = webApp.BackButton;
  if (!button) return () => undefined;
  button.onClick?.(onBack);
  button.show?.();
  return () => {
    button.offClick?.(onBack);
    button.hide?.();
  };
}
