// @vitest-environment node

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  createSupabaseNotificationStore,
  createSupabaseWebhookStore,
  NotificationStoreError,
} from '@/server/notifications/supabase-store';

const outboxId = '10000000-0000-4000-8000-000000000001';
const leaseId = '20000000-0000-4000-8000-000000000002';
const taskId = '40000000-0000-4000-8000-000000000001';

describe('Supabase notification operations adapter', () => {
  it('maps every worker operation to fixed RPC arguments and strictly parsed safe rows', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'plan_task_notifications') return { data: 3, error: null };
      if (name === 'claim_notification_outbox') return {
        data: [{ id: outboxId, lease_id: leaseId, kind: 'due_24h', task_id: taskId, attempts: 2 }], error: null,
      };
      if (name === 'revalidate_notification_outbox') return { data: [{ telegram_id: '4503599627370495' }], error: null };
      if (name === 'suppress_notification_outbox') return { data: true, error: null };
      if (name === 'complete_notification_outbox') return { data: true, error: null };
      if (name === 'fail_notification_outbox') return { data: 'retry', error: null };
      throw new Error('unexpected rpc');
    });
    const store = createSupabaseNotificationStore({ rpc } as unknown as SupabaseClient);
    const claimed = await store.claim(20);

    await expect(store.plan()).resolves.toBe(3);
    expect(claimed).toEqual([{ id: outboxId, leaseId, kind: 'due_24h', taskId, attempts: 2 }]);
    await expect(store.revalidate(claimed[0]!)).resolves.toEqual({ telegramId: '4503599627370495' });
    await expect(store.suppress(claimed[0]!)).resolves.toBe(true);
    await expect(store.complete(claimed[0]!, 991)).resolves.toBe(true);
    await expect(store.fail(claimed[0]!, {
      code: 'network_error', retryAfterSeconds: 30, permanent: false,
    })).resolves.toBe('retry');

    expect(rpc.mock.calls).toEqual([
      ['claim_notification_outbox', { p_limit: 20 }],
      ['plan_task_notifications'],
      ['revalidate_notification_outbox', { p_outbox_id: outboxId, p_lease_id: leaseId }],
      ['suppress_notification_outbox', { p_outbox_id: outboxId, p_lease_id: leaseId }],
      ['complete_notification_outbox', { p_outbox_id: outboxId, p_lease_id: leaseId, p_telegram_message_id: 991 }],
      ['fail_notification_outbox', {
        p_outbox_id: outboxId, p_lease_id: leaseId, p_error_code: 'network_error',
        p_retry_after_seconds: 30, p_permanent: false,
      }],
    ]);
  });

  it('rejects malformed RPC data and errors without leaking database details', async () => {
    for (const result of [
      { data: [{ id: outboxId, lease_id: leaseId, kind: 'arbitrary', task_id: taskId, attempts: 1 }], error: null },
      { data: [{ id: outboxId, lease_id: leaseId, kind: 'mention', task_id: taskId, attempts: 9 }], error: null },
      { data: null, error: { message: 'RAW_DATABASE_SECRET_SENTINEL' } },
    ]) {
      const store = createSupabaseNotificationStore({
        rpc: vi.fn().mockResolvedValue(result),
      } as unknown as SupabaseClient);
      const error = await store.claim(20).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotificationStoreError);
      expect(String(error)).not.toContain('RAW_DATABASE_SECRET_SENTINEL');
      expect(String(error)).not.toContain('arbitrary');
    }
  });

  it('durably records only a bounded Telegram update id with a strict boolean result', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const store = createSupabaseWebhookStore({ rpc } as unknown as SupabaseClient);
    await expect(store.recordUpdate(9_223_372_036_854_775n)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_telegram_webhook_update', {
      p_update_id: '9223372036854775',
    });

    rpc.mockResolvedValueOnce({ data: 'true', error: null });
    await expect(store.recordUpdate(1n)).rejects.toBeInstanceOf(NotificationStoreError);
  });
});
