'use client';

import { useState } from 'react';

import { AppShell, type ViewKey } from '@/components/app-shell';
import { TaskWorkspace } from '@/features/tasks/task-workspace';
import { WorkspaceProvider } from '@/providers/workspace-provider';

const viewTitles: Record<ViewKey, string> = {
  today: 'Сегодня',
  tasks: 'Задачи',
  knowledge: 'База знаний',
  people: 'Люди',
};

export default function Home() {
  const [activeView, setActiveView] = useState<ViewKey>('today');
  const [createRequest, setCreateRequest] = useState(0);

  return (
    <WorkspaceProvider>
      <AppShell activeView={activeView} onCreate={() => setCreateRequest((value) => value + 1)} onNavigate={setActiveView}>
        <div className="demo-banner" role="status">Демо-режим · данные хранятся только в этом браузере</div>
        {activeView === 'today' || activeView === 'tasks' ? (
          <TaskWorkspace activeView={activeView} createRequest={createRequest} />
        ) : (
          <section aria-labelledby="view-title" className="workspace-loading">
            <p className="workspace-loading__eyebrow">Smoking Zen</p>
            <h1 id="view-title">{viewTitles[activeView]}</h1>
            <p>Раздел готовится.</p>
          </section>
        )}
      </AppShell>
    </WorkspaceProvider>
  );
}
