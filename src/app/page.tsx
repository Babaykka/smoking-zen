'use client';

import { useState } from 'react';

import { AppShell, type ViewKey } from '@/components/app-shell';

const viewTitles: Record<ViewKey, string> = {
  today: 'Сегодня',
  tasks: 'Задачи',
  knowledge: 'База знаний',
  people: 'Люди',
};

export default function Home() {
  const [activeView, setActiveView] = useState<ViewKey>('today');

  return (
    <AppShell activeView={activeView} onCreate={() => {}} onNavigate={setActiveView}>
      <div className="demo-banner" role="status">
        Демо-режим: рабочие данные не подключены.
      </div>
      <section aria-labelledby="view-title" className="workspace-loading">
        <p className="workspace-loading__eyebrow">Smoking Zen</p>
        <h1 id="view-title">{viewTitles[activeView]}</h1>
        <p role="status">Загружаем рабочее пространство…</p>
      </section>
    </AppShell>
  );
}
