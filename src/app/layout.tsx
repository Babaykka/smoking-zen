import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Штаб',
  description: 'Рабочее пространство Smoking Zen',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

const telegramWebAppScript = 'https://telegram.org/js/telegram-web-app.js?63';

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- Telegram requires its bridge before application bootstrap. */}
        <script
          nonce={nonce}
          src={telegramWebAppScript}
          suppressHydrationWarning
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
