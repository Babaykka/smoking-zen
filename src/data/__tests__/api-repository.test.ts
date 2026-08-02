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

  it('merges a partial hydration without clearing existing knowledge or contacts and rejects a foreign workspace', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { workspaceId: demoSeed.workspaceId, tasks: [] }, error: null, requestId: 'request-partial',
    }), { status: 200 }));
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });
    await repository.hydrate();
    expect(repository.snapshot().knowledge).toEqual(demoSeed.knowledge);
    expect(repository.snapshot().contacts).toEqual(demoSeed.contacts);

    const foreign = createApiRepository({ initialSnapshot: demoSeed, fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { ...demoSeed, workspaceId: 'other-workspace' }, error: null, requestId: 'request-foreign',
    }), { status: 200 })), realtime: () => () => {} });
    await expect(foreign.hydrate()).rejects.toThrow('другого рабочего пространства');
  });

  it('sends search text only in a POST body and returns an empty result for a blank query', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ entity: 'contact', id: 'contact-coal', title: 'Поставщик угля' }], error: null, requestId: 'request-search',
    }), { status: 200 }));
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });
    await expect(repository.search('уголь')).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith('/api/search', expect.objectContaining({ method: 'POST', body: JSON.stringify({ query: 'уголь' }) }));
    await expect(repository.search('   ')).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('runs sign-upload-complete without retaining signed URLs or bytes in workspace state', async () => {
    const attachment = { id: 'attachment-ready', name: 'policy.txt', mimeType: 'text/plain', size: 18 };
    const signed = {
      ...attachment,
      uploadUrl: 'https://storage.example/storage/v1/object/upload/sign/workspace-files/10000000-0000-4000-8000-000000000001?token=ephemeral',
      expiresAt: '2026-08-02T14:05:00.000Z',
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: signed, error: null, requestId: 'sign' }), { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: attachment, error: null, requestId: 'complete' }), { status: 200 }));
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });
    const progress: number[] = [];
    const file = new File(['Регламент смены.\n'], 'policy.txt', { type: 'text/plain' });

    await expect(repository.uploadAttachment(
      { type: 'task', id: demoSeed.tasks[0]!.id },
      file,
      (value) => progress.push(value),
    )).resolves.toEqual(attachment);

    const signCall = fetcher.mock.calls[0]!;
    expect(signCall[0]).toBe('/api/files/sign-upload');
    expect(JSON.parse(String((signCall[1] as RequestInit).body))).toMatchObject({
      parentType: 'task', parentId: demoSeed.tasks[0]!.id, name: 'policy.txt', declaredMime: 'text/plain', size: file.size,
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, signed.uploadUrl, expect.objectContaining({ method: 'PUT', body: file }));
    expect(fetcher).toHaveBeenNthCalledWith(3, `/api/files/${attachment.id}/complete`, expect.objectContaining({ method: 'POST' }));
    expect(progress).toEqual([10, 30, 80, 100]);
    expect(repository.snapshot().tasks[0]!.attachments).toEqual([attachment]);
    expect(JSON.stringify(repository.snapshot())).not.toMatch(/private-upload|token=ephemeral|Регламент смены/iu);
  });

  it('opens downloads through a same-origin redirect route without fetching or retaining a provider URL', async () => {
    const fetcher = vi.fn();
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });

    await expect(repository.downloadAttachment('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).resolves.toEqual({
      url: '/api/files/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/download',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(repository.snapshot())).not.toMatch(/storage\/v1|token=|storagePath/iu);
  });

  it('rejects a forbidden file locally before requesting an upload grant', async () => {
    const fetcher = vi.fn();
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });
    const svg = new File(['<svg><script>alert(1)</script></svg>'], 'unsafe.svg', { type: 'image/svg+xml' });

    await expect(repository.uploadAttachment({ type: 'task', id: demoSeed.tasks[0]!.id }, svg))
      .rejects.toThrow(/Разрешены только JPEG/iu);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps Safe summaries in state while reveal URLs remain response-local', async () => {
    const created = {
      ...demoSeed.secureItems[0]!, id: 'safe-new', title: 'Терминал', version: 1,
    };
    const externalUrl = 'https://vault.bitwarden.com/#/items/memory-only-response';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: created, error: null, requestId: 'create' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { externalUrl }, error: null, requestId: 'reveal' }), { status: 200 }));
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });

    await repository.createSecureItem({
      title: 'Терминал', purpose: 'Оплата', owner: 'Управляющий', externalUrl,
    });
    await expect(repository.revealSecureItem('safe-new')).resolves.toEqual({ externalUrl });

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/secure-items', expect.objectContaining({
      method: 'POST', body: expect.stringContaining(externalUrl),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/secure-items/safe-new/reveal', expect.objectContaining({ method: 'POST' }));
    expect(repository.snapshot().secureItems).toContainEqual(created);
    expect(JSON.stringify(repository.snapshot())).not.toContain(externalUrl);
  });

  it('removes an archived Safe summary and restores it through the recovery action', async () => {
    const current = demoSeed.secureItems[0]!;
    const deleted = { ...current, version: 2, deletedAt: '2026-08-02T14:00:00.000Z' };
    const restored = { ...current, version: 3, deletedAt: null };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: deleted, error: null, requestId: 'delete' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: restored, error: null, requestId: 'restore' }), { status: 200 }));
    const repository = createApiRepository({ initialSnapshot: demoSeed, fetcher, realtime: () => () => {} });

    await repository.deleteSecureItem(current.id, current.version);
    expect(repository.snapshot().secureItems).not.toContainEqual(expect.objectContaining({ id: current.id }));
    await repository.restoreSecureItem(current.id, deleted.version);

    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/secure-items/${current.id}`, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ action: 'restore', expectedVersion: 2 }),
    }));
    expect(repository.snapshot().secureItems).toContainEqual(restored);
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
