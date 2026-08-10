'use client';

import { useEffect, useEffectEvent } from 'react';

import { bindTelegramBackButton } from '@/lib/telegram-web-app';

export function useTelegramBackButton(active: boolean, onBack: () => void) {
  const handleBack = useEffectEvent(onBack);
  useEffect(
    () => bindTelegramBackButton(active, handleBack),
    [active],
  );
}
