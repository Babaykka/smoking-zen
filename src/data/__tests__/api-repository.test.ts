// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createApiRepository } from '@/data/api-repository';
import { demoSeed } from '@/data/demo-seed';
import { subscribeWorkspaceRealtime } from '@/data/realtime';

describe('API task repository', () => {
  it('hydrates through credentials-protected APIs and refetches after Realtime invalidation', async () => {
    let invalidate: (() => void) | undefined;
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: demoSeed, error: null, requestId: 'request-1' }), { status: 200 }));
    const realtime = vi.fn((_workspaceId: string, listener: () => void) => {
      invalidate = listener;
      return () => {};
    });
    const repository = createApiRepository({ initialSnapshot: { ...demoSeed, tasks: [] }, fetcher, realtime });

    await repository.hydrate();
    expect(repository.snapshot().tasks).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith('/api/tasks', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    await repository.hydrate();
    expect(fetcher).toHaveBeenCalledTimes(1);

    invalidate?.();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('maps a 409 response to ConflictError while preserving the submitted input', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { expectedVersion: 1, actualVersion: 2 },
      error: { code: 'version_conflict', message: 'Конфликт версий.' },
      requestId: 'request-2',
    }), { status: 409 }));
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });

    await expect(repository.updateTask('task-check-coals', { title: 'Мой текст' }, 1)).rejects.toMatchObject({
      name: 'ConflictError', expectedVersion: 1, actualVersion: 2,
    });
    expect(repository.pendingTaskInput('task-check-coals')).toEqual({ title: 'Мой текст' });
  });

  it('disposes its Realtime subscription safely more than once', () => {
    const unsubscribe = vi.fn();
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher: vi.fn(), realtime: () => unsubscribe });

    repository.dispose?.();
    repository.dispose?.();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('workspace Realtime', () => {
  it('subscribes to a private workspace-only Broadcast channel without putting credentials in its name', () => {
    let broadcastCallback: (() => void) | undefined;
    let statusCallback: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn((_type: string, _filter: { event: string }, callback: () => void) => { broadcastCallback = callback; return channel; }),
      subscribe: vi.fn((callback: (status: string) => void) => { statusCallback = callback; return channel; }),
    };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
    const listener = vi.fn();

    const unsubscribe = subscribeWorkspaceRealtime(client, '33333333-3333-4333-8333-333333333333', listener, { schedule: () => 1, cancel: () => {} });
    expect(client.channel).toHaveBeenCalledWith('workspace:33333333-3333-4333-8333-333333333333', { config: { private: true } });
    broadcastCallback?.();
    expect(listener).toHaveBeenCalledOnce();
    expect(JSON.stringify(client.channel.mock.calls)).not.toContain('token');
    unsubscribe();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
    expect(statusCallback).toBeDefined();
  });

  it('rejects channel injection and reconnects with bounded backoff after an error', () => {
    const statuses: Array<(status: string) => void> = [];
    const delays: number[] = [];
    const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn((callback: (status: string) => void) => { statuses.push(callback); return channel; }) };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
    expect(() => subscribeWorkspaceRealtime(client, 'workspace:other\nsecret', () => {})).toThrow('workspace');

    subscribeWorkspaceRealtime(client, '33333333-3333-4333-8333-333333333333', () => {}, {
      schedule: (callback, delay) => { delays.push(delay); callback(); return delays.length; }, cancel: () => {},
    });
    statuses[0]?.('CHANNEL_ERROR');
    expect(delays[0]).toBe(1_000);
    expect(client.channel).toHaveBeenCalledTimes(2);
  });

  it('keeps one reconnect timer and ignores stale channel callbacks after cleanup', () => {
    const statuses: Array<(status: string) => void> = [];
    const channels = Array.from({ length: 3 }, (_, index) => ({
      id: index,
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((callback: (status: string) => void) => { statuses.push(callback); return channels[index]!; }),
    }));
    const client = { channel: vi.fn(() => channels[client.channel.mock.calls.length - 1]!), removeChannel: vi.fn() };
    const scheduled: Array<() => void> = [];
    const cancelled: number[] = [];
    const unsubscribe = subscribeWorkspaceRealtime(client, '33333333-3333-4333-8333-333333333333', () => {}, {
      schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
      cancel: (timer) => { cancelled.push(Number(timer)); },
    });

    statuses[0]?.('CHANNEL_ERROR');
    statuses[0]?.('CHANNEL_ERROR');
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    statuses[0]?.('CLOSED');
    expect(scheduled).toHaveLength(1);

    statuses[1]?.('TIMED_OUT');
    expect(scheduled).toHaveLength(2);
    unsubscribe();
    scheduled[1]?.();

    expect(client.channel).toHaveBeenCalledTimes(2);
    expect(client.removeChannel).toHaveBeenCalledWith(channels[0]);
    expect(client.removeChannel).toHaveBeenCalledWith(channels[1]);
    expect(cancelled).toContain(2);
  });
});
