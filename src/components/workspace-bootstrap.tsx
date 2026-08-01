'use client';

import { createClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { AppShell, type ViewKey } from '@/components/app-shell';
import { createApiRepository } from '@/data/api-repository';
import { createDemoRepository } from '@/data/demo-repository';
import { createRealtimeTokenManager, type RealtimeTokenManager } from '@/data/realtime-auth';
import { subscribeWorkspaceRealtime, type WorkspaceRealtimeClient } from '@/data/realtime';
import { createDemoGateway, type WorkspaceGateway } from '@/data/workspace-gateway';
import { TaskWorkspace } from '@/features/tasks/task-workspace';
import type { WorkspaceSnapshot } from '@/domain/types';
import { WorkspaceProvider } from '@/providers/workspace-provider';

export type BrowserProductionConfig = { supabaseUrl: string; supabasePublishableKey: string };
type ProductionRealtimeClient = WorkspaceRealtimeClient & { realtime: { setAuth(token: string): void | Promise<void> } };

type WorkspaceBootstrapProps = {
  mode: 'demo' | 'production';
  productionConfig?: BrowserProductionConfig;
  fetcher?: typeof fetch;
  demoGatewayFactory?: () => WorkspaceGateway;
  realtimeClientFactory?: (config: BrowserProductionConfig, tokenManager: RealtimeTokenManager) => ProductionRealtimeClient;
};

const viewTitles: Record<ViewKey, string> = {
  today: 'Сегодня', tasks: 'Задачи', knowledge: 'База знаний', people: 'Люди',
};

function defaultDemoGatewayFactory() {
  return createDemoGateway(createDemoRepository());
}

function defaultRealtimeClientFactory(config: BrowserProductionConfig, tokenManager: RealtimeTokenManager): ProductionRealtimeClient {
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    accessToken: () => tokenManager.getAccessToken(),
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as ProductionRealtimeClient;
}

function emptyWorkspace(workspaceId: string): WorkspaceSnapshot {
  return {
    workspaceId, taskStatuses: [], sections: [], tasks: [], comments: [], knowledge: [], contacts: [], members: [],
    secureItems: [], auditEvents: [], notificationDeliveries: [],
  };
}

function WorkspaceApplication({ gateway, mode }: { gateway: WorkspaceGateway; mode: 'demo' | 'production' }) {
  const [activeView, setActiveView] = useState<ViewKey>('today');
  const [createRequest, setCreateRequest] = useState(0);
  return (
    <WorkspaceProvider gateway={gateway}>
      <AppShell activeView={activeView} onCreate={() => setCreateRequest((value) => value + 1)} onNavigate={setActiveView}>
        {mode === 'demo' && <div className="demo-banner" role="status">Демо-режим · данные хранятся только в этом браузере</div>}
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

export function WorkspaceBootstrap({
  mode,
  productionConfig,
  fetcher = fetch,
  demoGatewayFactory = defaultDemoGatewayFactory,
  realtimeClientFactory = defaultRealtimeClientFactory,
}: WorkspaceBootstrapProps) {
  const [state, setState] = useState<{ gateway: WorkspaceGateway | null; error: string | null }>(() => ({
    gateway: mode === 'demo' ? demoGatewayFactory() : null,
    error: null,
  }));

  useEffect(() => {
    if (mode === 'demo') return;
    let cancelled = false;
    let gateway: WorkspaceGateway | null = null;
    let tokenManager: RealtimeTokenManager | null = null;

    void (async () => {
      await Promise.resolve();
      const initData = (window as typeof window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData;
      if (!initData) {
        if (!cancelled) setState({ gateway: null, error: 'Откройте приложение в Telegram для безопасного входа.' });
        return;
      }
      if (!productionConfig) {
        if (!cancelled) setState({ gateway: null, error: 'Сервис временно недоступен.' });
        return;
      }

      try {
        const sessionResponse = await fetcher('/api/session/telegram', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ initData }),
        });
        if (!sessionResponse.ok) throw new Error('Авторизация Telegram недействительна.');

        let realtimeClient: ProductionRealtimeClient | null = null;
        tokenManager = createRealtimeTokenManager({
          fetcher,
          setAuth: (token) => realtimeClient?.realtime.setAuth(token),
        });
        const token = await tokenManager.getAccessToken();
        const workspaceId = await tokenManager.getWorkspaceId();
        realtimeClient = realtimeClientFactory(productionConfig, tokenManager);
        await realtimeClient.realtime.setAuth(token);
        gateway = createApiRepository({
          initialSnapshot: emptyWorkspace(workspaceId),
          fetcher,
          realtime: (id, listener) => subscribeWorkspaceRealtime(realtimeClient!, id, listener),
        });
        await gateway.hydrate();
        if (!cancelled) setState({ gateway, error: null });
      } catch (error) {
        gateway?.dispose?.();
        tokenManager?.clear();
        if (!cancelled) setState({ gateway: null, error: error instanceof Error ? error.message : 'Сервис временно недоступен.' });
      }
    })();

    return () => {
      cancelled = true;
      gateway?.dispose?.();
      tokenManager?.clear();
    };
  }, [fetcher, mode, productionConfig, realtimeClientFactory]);

  if (state.error) return <main className="bootstrap-state"><p role="alert">{state.error}</p></main>;
  if (!state.gateway) return <main className="bootstrap-state"><p role="status">Подключаем рабочее пространство…</p></main>;
  return <WorkspaceApplication gateway={state.gateway} mode={mode} />;
}
