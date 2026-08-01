import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceBootstrap } from '@/components/workspace-bootstrap';
import { demoSeed } from '@/data/demo-seed';

const workspaceId = '33333333-3333-4333-8333-333333333333';
const productionConfig = { supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_test' };

function response(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ data, error: status < 400 ? null : { code: 'failed', message: 'Ошибка' }, requestId: 'request-1' }), { status }));
}

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
});
