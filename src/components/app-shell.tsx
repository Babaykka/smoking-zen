'use client';

import { CirclePlus } from 'lucide-react';
import type { ReactNode } from 'react';

import { Navigation, type ViewKey } from '@/components/navigation';
import { Button } from '@/components/ui/button';

export type { ViewKey } from '@/components/navigation';

export type AppShellProps = {
  activeView: ViewKey;
  onNavigate: (view: ViewKey) => void;
  onCreate: () => void;
  children: ReactNode;
};

export function AppShell({ activeView, children, onCreate, onNavigate }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <p className="app-shell__brand">Штаб</p>
        <Navigation activeView={activeView} onNavigate={onNavigate} variant="sidebar" />
        <Button aria-label="Создать задачу" className="app-shell__create" onClick={onCreate}>
          <CirclePlus aria-hidden="true" size={20} />
          <span>Создать</span>
        </Button>
      </aside>

      <main className="app-shell__content">{children}</main>

      <Button aria-label="Создать задачу" className="app-shell__floating-create" onClick={onCreate}>
        <CirclePlus aria-hidden="true" size={24} />
      </Button>
      <Navigation activeView={activeView} onNavigate={onNavigate} variant="bottom" />
    </div>
  );
}
