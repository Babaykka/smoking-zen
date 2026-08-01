// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { createRealtimeTokenManager } from '@/data/realtime-auth';

const envelope = (token: string, expiresAt: string) => new Response(JSON.stringify({ data: {
  token, workspaceId: '33333333-3333-4333-8333-333333333333', expiresAt,
}, error: null, requestId: 'request-1' }), { status: 200 });

describe('RealtimeTokenManager', () => {
  it('keeps the token in memory, refreshes before expiry, and pushes refreshed auth to Realtime', async () => {
    let now = new Date('2026-08-02T10:00:00.000Z');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(envelope('first-token', '2026-08-02T10:05:00.000Z'))
      .mockResolvedValueOnce(envelope('second-token', '2026-08-02T10:10:00.000Z'));
    const setAuth = vi.fn();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const initialUrl = window.location.href;
    const manager = createRealtimeTokenManager({ fetcher, now: () => now, setAuth });

    expect(await manager.getAccessToken()).toBe('first-token');
    now = new Date('2026-08-02T10:04:10.000Z');
    expect(await manager.getAccessToken()).toBe('second-token');
    expect(setAuth).toHaveBeenNthCalledWith(1, 'first-token');
    expect(setAuth).toHaveBeenNthCalledWith(2, 'second-token');
    expect(storageWrite).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialUrl);
    expect(JSON.stringify([...consoleError.mock.calls, ...consoleLog.mock.calls, ...consoleWarn.mock.calls])).not.toContain('token');

    manager.clear();
    expect(manager.peek()).toBeNull();
    storageWrite.mockRestore();
    consoleError.mockRestore();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it('refreshes and reapplies authentication before expiry without creating another channel', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(envelope('first-token', '2026-08-02T10:05:00.000Z'))
      .mockResolvedValueOnce(envelope('second-token', '2026-08-02T10:10:00.000Z'));
    const setAuth = vi.fn();
    const channel = vi.fn();
    const manager = createRealtimeTokenManager({ fetcher, setAuth });

    await manager.getAccessToken();
    channel('workspace:33333333-3333-4333-8333-333333333333');
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(setAuth).toHaveBeenNthCalledWith(2, 'second-token');
    expect(channel).toHaveBeenCalledOnce();
    manager.clear();
    vi.useRealTimers();
  });

  it('rejects malformed workspace and expiration metadata before applying auth', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));
    const fetcher = vi.fn().mockResolvedValue(envelope('untrusted-token', 'not-a-date'));
    const responseWithInvalidWorkspace = await fetcher();
    const invalidPayload = await responseWithInvalidWorkspace.json() as { data: { workspaceId: string } };
    invalidPayload.data.workspaceId = 'not-a-workspace';
    fetcher.mockResolvedValue(new Response(JSON.stringify(invalidPayload), { status: 200 }));
    const setAuth = vi.fn();
    const manager = createRealtimeTokenManager({ fetcher, setAuth });

    await expect(manager.getAccessToken()).rejects.toThrow('некоррект');
    expect(setAuth).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    manager.clear();
    vi.useRealTimers();
  });

  it('retries a transient scheduled refresh failure with backoff and reapplies auth', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));
    const transientFailure = new Response(JSON.stringify({ data: null, error: { message: 'Временный сбой.' }, requestId: 'request-2' }), { status: 503 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(envelope('first-token', '2026-08-02T10:05:00.000Z'))
      .mockResolvedValueOnce(transientFailure)
      .mockResolvedValueOnce(envelope('second-token', '2026-08-02T10:10:00.000Z'));
    const setAuth = vi.fn();
    const manager = createRealtimeTokenManager({ fetcher, setAuth });

    await manager.getAccessToken();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(setAuth).toHaveBeenNthCalledWith(2, 'second-token');
    manager.clear();
    vi.useRealTimers();
  });
});
