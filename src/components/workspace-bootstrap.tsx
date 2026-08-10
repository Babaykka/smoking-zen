'use client';

import { createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AppShell, type ViewKey } from '@/components/app-shell';
import { createApiRepository } from '@/data/api-repository';
import { createDemoRepository } from '@/data/demo-repository';
import { createRealtimeTokenManager, type RealtimeTokenManager } from '@/data/realtime-auth';
import { subscribeWorkspaceRealtime, type WorkspaceRealtimeClient } from '@/data/realtime';
import { createDemoGateway, type WorkspaceGateway } from '@/data/workspace-gateway';
import { TaskWorkspace } from '@/features/tasks/task-workspace';
import { KnowledgeWorkspace } from '@/features/knowledge/knowledge-workspace';
import { PeopleWorkspace } from '@/features/people/people-workspace';
import { GlobalSearch } from '@/features/search/global-search';
import { SecureItemsWorkspace } from '@/features/secure-items/secure-items-workspace';
import type { SearchNavigationTarget, SearchResult, WorkspaceSnapshot } from '@/domain/types';
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
  safe: 'Сейф',
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

function taskLaunchFromSession(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const launch = (data as Record<string, unknown>).launch;
  if (launch === null || launch === undefined) return null;
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) return null;
  const candidate = launch as Record<string, unknown>;
  return candidate.kind === 'task'
    && typeof candidate.taskId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.taskId)
    ? candidate.taskId
    : null;
}

function WorkspaceApplication({ gateway, mode, launchTaskId }: {
  gateway: WorkspaceGateway;
  mode: 'demo' | 'production';
  launchTaskId: string | null;
}) {
  const [activeView, setActiveView] = useState<ViewKey>(launchTaskId ? 'tasks' : 'today');
  const [pendingLaunchTaskId, setPendingLaunchTaskId] = useState(launchTaskId);
  const [createRequest, setCreateRequest] = useState(0);
  const [searchTarget, setSearchTarget] = useState<(SearchResult & SearchNavigationTarget) | null>(null);
  const searchRequestKey = useRef(0);
  const openSearchResult = (result: SearchResult) => {
    setSearchTarget({ ...result, requestKey: ++searchRequestKey.current });
    setActiveView(result.entity === 'task' ? 'tasks' : result.entity === 'knowledge' ? 'knowledge' : 'people');
  };
  const consumeSearchTarget = useCallback((requestKey: number) => {
    setSearchTarget((current) => current?.requestKey === requestKey ? null : current);
  }, []);
  const navigate = (view: ViewKey) => { setSearchTarget(null); setActiveView(view); };
  return (
    <WorkspaceProvider gateway={gateway}>
      <AppShell activeView={activeView} onCreate={() => setCreateRequest((value) => value + 1)} onNavigate={navigate}>
        {mode === 'demo' && <div className="demo-banner" role="status">Демо-режим: рабочие данные не подключены.</div>}
        <GlobalSearch onOpen={openSearchResult} />
        {activeView === 'today' || activeView === 'tasks' ? (
          <TaskWorkspace
            activeView={activeView}
            createRequest={createRequest}
            launchTaskId={pendingLaunchTaskId ?? undefined}
            onLaunchTaskConsumed={() => setPendingLaunchTaskId(null)}
            onSearchTargetConsumed={consumeSearchTarget}
            searchTarget={searchTarget?.entity === 'task' ? searchTarget : undefined}
          />
        ) : activeView === 'knowledge' ? (
          <KnowledgeWorkspace onSearchTargetConsumed={consumeSearchTarget} searchTarget={searchTarget?.entity === 'knowledge' ? searchTarget : undefined} />
        ) : activeView === 'people' ? (
          <PeopleWorkspace onSearchTargetConsumed={consumeSearchTarget} searchTarget={searchTarget?.entity === 'contact' ? searchTarget : undefined} />
        ) : activeView === 'safe' ? (
          <SecureItemsWorkspace />
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
  const [state, setState] = useState<{ gateway: WorkspaceGateway | null; error: string | null; launchTaskId: string | null }>(() => ({
    gateway: mode === 'demo' ? demoGatewayFactory() : null,
    error: null,
    launchTaskId: null,
  }));

  useEffect(() => {
    if (mode === 'demo') return;
    let active = true;
    let gateway: WorkspaceGateway | null = null;
    let tokenManager: RealtimeTokenManager | null = null;
    const controller = new AbortController();
    let resourcesDisposed = false;

    const disposeResources = () => {
      if (resourcesDisposed) return;
      resourcesDisposed = true;
      controller.abort();
      gateway?.dispose?.();
      gateway = null;
      tokenManager?.clear();
      tokenManager = null;
    };

    const stopIfInactive = () => {
      if (active) return false;
      disposeResources();
      return true;
    };

    void (async () => {
      await Promise.resolve();
      if (stopIfInactive()) return;
      const initData = (window as typeof window & { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData;
      if (!initData) {
        if (active) setState({ gateway: null, error: 'Откройте приложение в Telegram для безопасного входа.', launchTaskId: null });
        return;
      }
      if (!productionConfig) {
        if (active) setState({ gateway: null, error: 'Сервис временно недоступен.', launchTaskId: null });
        return;
      }

      try {
        const sessionResponse = await fetcher('/api/session/telegram', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ initData }),
          signal: controller.signal,
        });
        if (stopIfInactive()) return;
        if (!sessionResponse.ok) throw new Error('Авторизация Telegram недействительна.');
        const sessionPayload: unknown = await sessionResponse.json();
        if (stopIfInactive()) return;
        const launchTaskId = taskLaunchFromSession(sessionPayload);

        let realtimeClient: ProductionRealtimeClient | null = null;
        tokenManager = createRealtimeTokenManager({
          fetcher,
          setAuth: (token) => realtimeClient?.realtime.setAuth(token),
          signal: controller.signal,
        });
        const token = await tokenManager.getAccessToken();
        if (stopIfInactive()) return;
        const workspaceId = await tokenManager.getWorkspaceId();
        if (stopIfInactive()) return;
        realtimeClient = realtimeClientFactory(productionConfig, tokenManager);
        await realtimeClient.realtime.setAuth(token);
        if (stopIfInactive()) return;
        gateway = createApiRepository({
          initialSnapshot: emptyWorkspace(workspaceId),
          fetcher,
          realtime: (id, listener) => subscribeWorkspaceRealtime(realtimeClient!, id, listener),
          signal: controller.signal,
        });
        await gateway.hydrate();
        if (stopIfInactive()) return;
        if (active) setState({ gateway, error: null, launchTaskId });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        disposeResources();
        setState({ gateway: null, error: error instanceof Error ? error.message : 'Сервис временно недоступен.', launchTaskId: null });
      }
    })();

    return () => {
      active = false;
      disposeResources();
    };
  }, [fetcher, mode, productionConfig, realtimeClientFactory]);

  if (state.error) return <main className="bootstrap-state"><p role="alert">{state.error}</p></main>;
  if (!state.gateway) return <main className="bootstrap-state"><p role="status">Подключаем рабочее пространство…</p></main>;
  return <WorkspaceApplication gateway={state.gateway} launchTaskId={state.launchTaskId} mode={mode} />;
}
