import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { notificationKinds, type NotificationKind } from '@/server/notifications/policy';
import type {
  ClaimedNotification,
  NotificationFailure,
  NotificationWorkerStore,
} from '@/server/notifications/worker';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const telegramIdPattern = /^\d{1,16}$/u;
const maximumTelegramId = 4_503_599_627_370_495n;
const maximumBigint = 9_223_372_036_854_775_807n;

export class NotificationStoreError extends Error {
  constructor() {
    super('Notification persistence is unavailable.');
    this.name = 'NotificationStoreError';
  }
}

function invalid(): never {
  throw new NotificationStoreError();
}

async function rpc(client: SupabaseClient, name: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    const result = args === undefined ? await client.rpc(name) : await client.rpc(name, args);
    if (result.error) invalid();
    return result.data;
  } catch (error) {
    if (error instanceof NotificationStoreError) throw error;
    invalid();
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join('\0') !== [...keys].sort().join('\0')) invalid();
  return row;
}

function parseClaimed(value: unknown): ClaimedNotification[] {
  if (!Array.isArray(value)) invalid();
  return value.map((entry) => {
    const row = exactRecord(entry, ['id', 'lease_id', 'kind', 'task_id', 'attempts']);
    if (
      typeof row.id !== 'string' || !uuidPattern.test(row.id)
      || typeof row.lease_id !== 'string' || !uuidPattern.test(row.lease_id)
      || typeof row.task_id !== 'string' || !uuidPattern.test(row.task_id)
      || typeof row.kind !== 'string' || !notificationKinds.includes(row.kind as NotificationKind)
      || typeof row.attempts !== 'number' || !Number.isInteger(row.attempts)
      || row.attempts < 1 || row.attempts > 8
    ) invalid();
    return {
      id: row.id,
      leaseId: row.lease_id,
      kind: row.kind as NotificationKind,
      taskId: row.task_id,
      attempts: row.attempts,
    };
  });
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}

export function createSupabaseNotificationStore(client: SupabaseClient): NotificationWorkerStore {
  return {
    async plan() {
      const data = await rpc(client, 'plan_task_notifications');
      if (typeof data !== 'number' || !Number.isInteger(data) || data < 0) invalid();
      return data;
    },

    async claim(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
      return parseClaimed(await rpc(client, 'claim_notification_outbox', { p_limit: limit }));
    },

    async revalidate(job) {
      const data = await rpc(client, 'revalidate_notification_outbox', {
        p_outbox_id: job.id,
        p_lease_id: job.leaseId,
      });
      if (!Array.isArray(data)) invalid();
      if (data.length === 0) return null;
      if (data.length !== 1) invalid();
      const row = exactRecord(data[0], ['telegram_id']);
      if (typeof row.telegram_id !== 'string' || !telegramIdPattern.test(row.telegram_id)) invalid();
      const telegramId = BigInt(row.telegram_id);
      if (telegramId <= 0n || telegramId > maximumTelegramId) invalid();
      return { telegramId: row.telegram_id };
    },

    async suppress(job) {
      return parseBoolean(await rpc(client, 'suppress_notification_outbox', {
        p_outbox_id: job.id,
        p_lease_id: job.leaseId,
      }));
    },

    async complete(job, messageId) {
      if (!Number.isSafeInteger(messageId) || messageId <= 0) invalid();
      return parseBoolean(await rpc(client, 'complete_notification_outbox', {
        p_outbox_id: job.id,
        p_lease_id: job.leaseId,
        p_telegram_message_id: messageId,
      }));
    },

    async fail(job, failure: NotificationFailure) {
      const data = await rpc(client, 'fail_notification_outbox', {
        p_outbox_id: job.id,
        p_lease_id: job.leaseId,
        p_error_code: failure.code,
        p_retry_after_seconds: failure.retryAfterSeconds,
        p_permanent: failure.permanent,
      });
      if (data !== 'retry' && data !== 'dead_letter' && data !== 'ignored') invalid();
      return data;
    },
  };
}

export type TelegramWebhookStore = { recordUpdate(updateId: bigint): Promise<boolean> };

export function createSupabaseWebhookStore(client: SupabaseClient): TelegramWebhookStore {
  return {
    async recordUpdate(updateId) {
      if (updateId < 0n || updateId > maximumBigint) invalid();
      return parseBoolean(await rpc(client, 'record_telegram_webhook_update', {
        p_update_id: updateId.toString(),
      }));
    },
  };
}
