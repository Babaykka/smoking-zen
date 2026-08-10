import { describe, expect, it } from 'vitest';

import type { NotificationKind } from '@/server/notifications/policy';
import { TelegramSendError } from '@/server/notifications/telegram-client';
import {
  runNotificationCycle,
  type ClaimedNotification,
  type NotificationWorkerStore,
} from '@/server/notifications/worker';

const taskId = '40000000-0000-4000-8000-000000000001';

function job(id: string, kind: NotificationKind, attempts = 1): ClaimedNotification {
  return {
    id,
    leaseId: id.replace(/^./u, 'f'),
    kind,
    taskId,
    attempts,
  };
}

describe('notification worker', () => {
  it('plans without caller scope or clock, revalidates immediately, and suppresses stale work', async () => {
    const active = job('10000000-0000-4000-8000-000000000001', 'assignment');
    const stale = job('20000000-0000-4000-8000-000000000002', 'due_24h');
    const sent: string[] = [];
    const completed: string[] = [];
    const failures: Array<{ id: string; code: string }> = [];
    const suppressed: string[] = [];
    const store: NotificationWorkerStore = {
      plan: async () => 2,
      claim: async (limit) => {
        expect(limit).toBe(20);
        return [active, stale];
      },
      revalidate: async (candidate) => candidate.id === active.id ? { telegramId: '123456789' } : null,
      complete: async (candidate, messageId) => {
        completed.push(`${candidate.id}:${messageId}`);
        return true;
      },
      suppress: async (candidate) => {
        suppressed.push(candidate.id);
        return true;
      },
      fail: async (candidate, failure) => {
        failures.push({ id: candidate.id, code: failure.code });
        return failure.permanent ? 'dead_letter' : 'retry';
      },
    };

    const result = await runNotificationCycle({
      store,
      telegram: {
        sendMessage: async ({ chatId }) => {
          sent.push(chatId);
          return { messageId: 777 };
        },
      },
      botUsername: 'a_bot',
      appShortName: 'app',
      random: () => 0,
    });

    expect(result).toEqual({ planned: 2, claimed: 2, delivered: 1, retried: 0, deadLettered: 0, suppressed: 1, indeterminate: 0 });
    expect(sent).toEqual(['123456789']);
    expect(completed).toEqual([`${active.id}:777`]);
    expect(failures).toEqual([]);
    expect(suppressed).toEqual([stale.id]);
  });

  it('records only enumerated safe failures and applies capped exponential retry with jitter', async () => {
    const candidate = job('30000000-0000-4000-8000-000000000003', 'mention', 7);
    const recorded: Array<{ code: string; retryAfterSeconds: number; permanent: boolean }> = [];
    const store: NotificationWorkerStore = {
      plan: async () => 0,
      claim: async () => [candidate],
      revalidate: async () => ({ telegramId: '123456789' }),
      complete: async () => false,
      suppress: async () => false,
      fail: async (_job, failure) => {
        recorded.push(failure);
        return 'retry';
      },
    };

    const result = await runNotificationCycle({
      store,
      telegram: {
        sendMessage: async () => {
          throw new TelegramSendError('network_error', false);
        },
      },
      botUsername: 'a_bot',
      appShortName: 'app',
      random: () => 0.999,
    });

    expect(result).toEqual({ planned: 0, claimed: 1, delivered: 0, retried: 1, deadLettered: 0, suppressed: 0, indeterminate: 0 });
    expect(recorded).toEqual([{ code: 'network_error', retryAfterSeconds: 1_949, permanent: false }]);
    expect(JSON.stringify(recorded)).not.toContain('socket');
  });

  it('honors a bounded Telegram rate-limit delay and dead-letters permanent failures', async () => {
    const rateLimited = job('40000000-0000-4000-8000-000000000004', 'due_24h');
    const blocked = job('50000000-0000-4000-8000-000000000005', 'overdue_daily');
    const recorded: Array<{ id: string; code: string; delay: number; permanent: boolean }> = [];
    const store: NotificationWorkerStore = {
      plan: async () => 0,
      claim: async () => [rateLimited, blocked],
      revalidate: async () => ({ telegramId: '123456789' }),
      complete: async () => false,
      suppress: async () => false,
      fail: async (candidate, failure) => {
        recorded.push({ id: candidate.id, code: failure.code, delay: failure.retryAfterSeconds, permanent: failure.permanent });
        return failure.permanent ? 'dead_letter' : 'retry';
      },
    };
    let calls = 0;

    const result = await runNotificationCycle({
      store,
      telegram: {
        sendMessage: async () => {
          calls += 1;
          if (calls === 1) throw new TelegramSendError('rate_limited', false, 3_600);
          throw new TelegramSendError('recipient_unavailable', true);
        },
      },
      botUsername: 'a_bot',
      appShortName: 'app',
      random: () => 0,
    });

    expect(result).toEqual({ planned: 0, claimed: 2, delivered: 0, retried: 1, deadLettered: 1, suppressed: 0, indeterminate: 0 });
    expect(recorded).toEqual([
      { id: rateLimited.id, code: 'rate_limited', delay: 3_600, permanent: false },
      { id: blocked.id, code: 'recipient_unavailable', delay: 0, permanent: true },
    ]);
  });

  it('propagates a persistence exception after Telegram accepted the message without recording a delivery failure', async () => {
    const candidate = job('60000000-0000-4000-8000-000000000006', 'assignment');
    const sentinel = new Error('PERSISTENCE_SENTINEL');
    const failures: string[] = [];
    const store: NotificationWorkerStore = {
      plan: async () => 0,
      claim: async () => [candidate],
      revalidate: async () => ({ telegramId: '123456789' }),
      complete: async () => { throw sentinel; },
      suppress: async () => false,
      fail: async (_job, failure) => {
        failures.push(failure.code);
        return 'dead_letter';
      },
    };

    await expect(runNotificationCycle({
      store,
      telegram: { sendMessage: async () => ({ messageId: 991 }) },
      botUsername: 'a_bot',
      appShortName: 'app',
    })).rejects.toBe(sentinel);
    expect(failures).toEqual([]);
  });

  it('surfaces a known Telegram success whose lease was concurrently lost as indeterminate', async () => {
    const candidate = job('70000000-0000-4000-8000-000000000007', 'mention');
    const failures: string[] = [];
    const store: NotificationWorkerStore = {
      plan: async () => 0,
      claim: async () => [candidate],
      revalidate: async () => ({ telegramId: '123456789' }),
      complete: async () => false,
      suppress: async () => false,
      fail: async (_job, failure) => {
        failures.push(failure.code);
        return 'dead_letter';
      },
    };

    await expect(runNotificationCycle({
      store,
      telegram: { sendMessage: async () => ({ messageId: 992 }) },
      botUsername: 'a_bot',
      appShortName: 'app',
    })).resolves.toEqual({
      planned: 0,
      claimed: 1,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      suppressed: 0,
      indeterminate: 1,
    });
    expect(failures).toEqual([]);
  });
});
