import {
  renderNotification,
  type NotificationKind,
} from '@/server/notifications/policy';
import {
  TelegramSendError,
  type TelegramClient,
  type TelegramFailureCode,
} from '@/server/notifications/telegram-client';

export type ClaimedNotification = {
  id: string;
  leaseId: string;
  kind: NotificationKind;
  taskId: string;
  attempts: number;
};

export type NotificationFailure = {
  code: TelegramFailureCode;
  retryAfterSeconds: number;
  permanent: boolean;
};

export interface NotificationWorkerStore {
  plan(): Promise<number>;
  claim(limit: number): Promise<ClaimedNotification[]>;
  revalidate(job: ClaimedNotification): Promise<{ telegramId: string } | null>;
  complete(job: ClaimedNotification, messageId: number): Promise<boolean>;
  suppress(job: ClaimedNotification): Promise<boolean>;
  fail(job: ClaimedNotification, failure: NotificationFailure): Promise<'retry' | 'dead_letter' | 'ignored'>;
}

type NotificationCycleOptions = {
  store: NotificationWorkerStore;
  telegram: TelegramClient;
  botUsername: string;
  appShortName: string;
  random?: () => number;
};

export type NotificationCycleResult = {
  planned: number;
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  suppressed: number;
  indeterminate: number;
};

const fixedBatchSize = 20;

function retryDelay(attempts: number, random: () => number): number {
  const exponential = Math.min(3_600, 30 * (2 ** Math.max(0, attempts - 1)));
  const jitter = Math.floor(Math.max(0, Math.min(0.999_999, random())) * 30);
  return Math.min(3_600, exponential + jitter);
}

export async function runNotificationCycle({
  store,
  telegram,
  botUsername,
  appShortName,
  random = Math.random,
}: NotificationCycleOptions): Promise<NotificationCycleResult> {
  const planned = await store.plan();
  const jobs = await store.claim(fixedBatchSize);
  const result: NotificationCycleResult = {
    planned,
    claimed: jobs.length,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    suppressed: 0,
    indeterminate: 0,
  };

  for (const job of jobs) {
    const recipient = await store.revalidate(job);
    if (!recipient) {
      if (await store.suppress(job)) result.suppressed += 1;
      continue;
    }

    let messageId: number;
    try {
      const message = renderNotification(job.kind, { botUsername, appShortName, taskId: job.taskId });
      const sent = await telegram.sendMessage({
        chatId: recipient.telegramId,
        text: message.text,
        taskUrl: message.taskUrl,
      });
      messageId = sent.messageId;
    } catch (error) {
      const failure = error instanceof TelegramSendError
        ? error
        : new TelegramSendError('configuration_error', true);
      const retryAfterSeconds = failure.permanent
        ? 0
        : failure.retryAfterSeconds || retryDelay(job.attempts, random);
      const outcome = await store.fail(job, {
        code: failure.code,
        retryAfterSeconds,
        permanent: failure.permanent,
      });
      if (outcome === 'retry') result.retried += 1;
      if (outcome === 'dead_letter') result.deadLettered += 1;
      continue;
    }

    if (await store.complete(job, messageId)) result.delivered += 1;
    else result.indeterminate += 1;
  }

  return result;
}
