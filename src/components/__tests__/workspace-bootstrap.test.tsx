import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceBootstrap } from '@/components/workspace-bootstrap';
import { demoSeed } from '@/data/demo-seed';

const workspaceId = '33333333-3333-4333-8333-333333333333';
const productionConfig = { supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_test' };

function response(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, error: status < 400 ? null : { code: 'failed', message: 'Ошибка' }, requestId: 'request-1' }), { status }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorkspaceBootstrap', () => {
  it('uses Telegram exchange and the API gateway in production without reading demo data', async () => {
    Object.defineProperty(window, 'Telegram', { configurable: true, value: { WebApp: { initData: 'signed-telegram-init-data' } } });
    const fetcher = vi.fn()
      .mockImplementationOnce(() => response({ membership: { workspaceId } }))
      .mockImplementationOnce(() => response({ token: 'memory-only-jwt', workspaceId, expiresAt: new Date(Date.now() + 300_000).toISOString() }))
      .mockImplementationOnce(() => response({ ...demoSeed, workspaceId, tasks: [{ ...demoSeed.tasks[0]!, workspaceId, title: 'Задача из API' }] }));
    const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
    const realtimeClientFactory = vi.fn(() => ({ channel: vi.fn(() => channel), removeChannel: vi.fn(), realtime: { setAuth: vi.fn() } }));
    const demoGatewayFactory = vi.fn(() => { throw new Error('demo must not be created'); });

    render(<WorkspaceBootstrap demoGatewayFactory={demoGatewayFactory} fetcher={fetcher} mode="production" productionConfig={productionConfig} realtimeClientFactory={realtimeClientFactory} />);

    expect(screen.queryByText('Проверить запас кокосового угля')).not.toBeInTheDocument();
    expect(await screen.findByText('Задача из API')).toBeInTheDocument();
    expect(demoGatewayFactory).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/session/telegram', expect.objectContaining({ method: 'POST', body: JSON.stringify({ initData: 'signed-telegram-init-data' }) }));
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/realtime/token', expect.objectContaining({ credentials: 'same-origin' }));
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/tasks', expect.objectContaining({ credentials: 'same-origin' }));
    expect(realtimeClientFactory).toHaveBeenCalledWith(productionConfig, expect.objectContaining({ getAccessToken: expect.any(Function) }));
  });

  it('fails closed outside Telegram in production instead of falling back to demo', async () => {
    Object.defineProperty(window, 'Telegram', { configurable: true, value: undefined });
    const demoGatewayFactory = vi.fn();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    render(<WorkspaceBootstrap demoGatewayFactory={demoGatewayFactory} mode="production" productionConfig={productionConfig} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Откройте приложение в Telegram');
    expect(demoGatewayFactory).not.toHaveBeenCalled();
    expect(screen.queryByText('Проверить запас кокосового угля')).not.toBeInTheDocument();
    expect(storageWrite).not.toHaveBeenCalled();
    storageWrite.mockRestore();
  });

  it('fails closed when production browser configuration is absent', async () => {
    Object.defineProperty(window, 'Telegram', { configurable: true, value: { WebApp: { initData: 'signed-telegram-init-data' } } });
    const demoGatewayFactory = vi.fn();
    const fetcher = vi.fn();
    render(<WorkspaceBootstrap demoGatewayFactory={demoGatewayFactory} fetcher={fetcher} mode="production" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервис временно недоступен');
    expect(demoGatewayFactory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps exactly one live usable private subscription under StrictMode', async () => {
    Object.defineProperty(window, 'Telegram', { configurable: true, value: { WebApp: { initData: 'signed-telegram-init-data' } } });
    const scheduleTimer = vi.spyOn(globalThis, 'setTimeout');
    const cancelTimer = vi.spyOn(globalThis, 'clearTimeout');
    let taskReads = 0;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/session/telegram') return response({ membership: { workspaceId } });
      if (url === '/api/realtime/token') return response({ token: 'memory-only-jwt', workspaceId, expiresAt: new Date(Date.now() + 300_000).toISOString() });
      if (url === '/api/tasks') {
        taskReads += 1;
        return response({ ...demoSeed, workspaceId, tasks: [{ ...demoSeed.tasks[0]!, workspaceId, title: taskReads > 1 ? 'Обновлено через Realtime' : 'Задача из API' }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const broadcastCallbacks: Array<() => void> = [];
    const channels: Array<{ on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }> = [];
    const client = {
      channel: vi.fn(() => {
        const channel = {
          on: vi.fn((_type: string, _filter: unknown, callback: () => void) => { broadcastCallbacks.push(callback); return channel; }),
          subscribe: vi.fn().mockReturnThis(),
        };
        channels.push(channel);
        return channel;
      }),
      removeChannel: vi.fn(),
      realtime: { setAuth: vi.fn() },
    };
    const rendered = render(
      <StrictMode>
        <WorkspaceBootstrap fetcher={fetcher} mode="production" productionConfig={productionConfig} realtimeClientFactory={() => client} />
      </StrictMode>,
    );

    expect(await screen.findByText('Задача из API')).toBeInTheDocument();
    expect(client.channel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).not.toHaveBeenCalled();
    const refreshTimerIndexes = scheduleTimer.mock.calls
      .map((call, index) => ({ delay: Number(call[1]), index }))
      .filter(({ delay }) => delay >= 60_000);
    expect(refreshTimerIndexes).toHaveLength(1);
    const refreshTimer = scheduleTimer.mock.results[refreshTimerIndexes[0]!.index]?.value;
    act(() => broadcastCallbacks[0]?.());
    expect(await screen.findByText('Обновлено через Realtime')).toBeInTheDocument();

    rendered.unmount();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(cancelTimer).toHaveBeenCalledWith(refreshTimer);
  });

  it.each(['session', 'token', 'hydrate'] as const)(
    'aborts and stops all continuation when unmounted during deferred %s',
    async (stage) => {
      Object.defineProperty(window, 'Telegram', { configurable: true, value: { WebApp: { initData: 'signed-telegram-init-data' } } });
      const blocked = deferred<Response>();
      const expiresAt = new Date(Date.now() + 300_000).toISOString();
      const fetcher = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/session/telegram') return stage === 'session' ? blocked.promise : response({ membership: { workspaceId } });
        if (url === '/api/realtime/token') return stage === 'token' ? blocked.promise : response({ token: 'memory-only-jwt', workspaceId, expiresAt });
        if (url === '/api/tasks') return stage === 'hydrate' ? blocked.promise : response({ ...demoSeed, workspaceId });
        throw new Error(`Unexpected request: ${url}`);
      });
      const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
      const client = { channel: vi.fn(() => channel), removeChannel: vi.fn(), realtime: { setAuth: vi.fn() } };
      const rendered = render(<WorkspaceBootstrap fetcher={fetcher} mode="production" productionConfig={productionConfig} realtimeClientFactory={() => client} />);
      const stageUrl = stage === 'session' ? '/api/session/telegram' : stage === 'token' ? '/api/realtime/token' : '/api/tasks';
      await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url) === stageUrl)).toBe(true));
      const stageCall = fetcher.mock.calls.find(([url]) => String(url) === stageUrl)!;

      rendered.unmount();
      expect((stageCall[1] as RequestInit | undefined)?.signal?.aborted).toBe(true);
      await act(async () => {
        blocked.resolve(await response(
          stage === 'session' ? { membership: { workspaceId } }
            : stage === 'token' ? { token: 'memory-only-jwt', workspaceId, expiresAt }
              : { ...demoSeed, workspaceId },
        ));
        await Promise.resolve();
        await Promise.resolve();
      });

      const expectedCalls = stage === 'session' ? 1 : stage === 'token' ? 2 : 3;
      expect(fetcher).toHaveBeenCalledTimes(expectedCalls);
      expect(client.channel).toHaveBeenCalledTimes(stage === 'hydrate' ? 1 : 0);
      expect(client.removeChannel).toHaveBeenCalledTimes(stage === 'hydrate' ? 1 : 0);
    },
  );
});
