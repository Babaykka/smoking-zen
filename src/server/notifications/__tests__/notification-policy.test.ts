import { describe, expect, it } from 'vitest';

import {
  assignmentNotificationKey,
  buildInviteDeepLink,
  buildTaskDeepLink,
  dueNotificationKey,
  mentionNotificationKey,
  moscowLocalDate,
  overdueNotificationKey,
  renderNotification,
} from '@/server/notifications/policy';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const taskId = '40000000-0000-4000-8000-000000000001';
const firstRecipientId = '30000000-0000-4000-8000-000000000001';
const secondRecipientId = '30000000-0000-4000-8000-000000000002';
const eventId = '90000000-0000-4000-8000-000000000001';

describe('notification policy', () => {
  it('builds stable recipient-scoped assignment and mention keys', () => {
    expect(assignmentNotificationKey(eventId, firstRecipientId))
      .toBe(`assignment:${eventId}:${firstRecipientId}`);
    expect(assignmentNotificationKey(eventId, secondRecipientId))
      .toBe(`assignment:${eventId}:${secondRecipientId}`);
    expect(mentionNotificationKey(eventId, firstRecipientId))
      .toBe(`mention:${eventId}:${firstRecipientId}`);
  });

  it('changes due keys only when the exact due timestamp or recipient changes', () => {
    const first = dueNotificationKey({
      workspaceId,
      taskId,
      recipientId: firstRecipientId,
      dueAt: '2026-08-03T08:00:00.000Z',
    });

    expect(first).toBe(
      `due_24h:${workspaceId}:${taskId}:${firstRecipientId}:1785744000000000`,
    );
    expect(dueNotificationKey({
      workspaceId,
      taskId,
      recipientId: firstRecipientId,
      dueAt: '2026-08-03T08:00:00.000Z',
    })).toBe(first);
    expect(dueNotificationKey({
      workspaceId,
      taskId,
      recipientId: firstRecipientId,
      dueAt: '2026-08-03T08:00:01.000Z',
    })).not.toBe(first);
  });

  it('canonicalizes equivalent due instants independently of timestamp offset', () => {
    const utc = dueNotificationKey({
      workspaceId,
      taskId,
      recipientId: firstRecipientId,
      dueAt: '2026-08-03T08:00:00.123456Z',
    });
    const moscow = dueNotificationKey({
      workspaceId,
      taskId,
      recipientId: firstRecipientId,
      dueAt: '2026-08-03T11:00:00.123456+03:00',
    });

    expect(utc).toBe(moscow);
    expect(utc).toBe(
      `due_24h:${workspaceId}:${taskId}:${firstRecipientId}:1785744000123456`,
    );
  });

  it('uses the Europe/Moscow calendar day for overdue idempotency', () => {
    expect(moscowLocalDate(new Date('2026-08-01T20:59:59.999Z'))).toBe('2026-08-01');
    expect(moscowLocalDate(new Date('2026-08-01T21:00:00.000Z'))).toBe('2026-08-02');
    expect(overdueNotificationKey({ workspaceId, taskId, recipientId: firstRecipientId, localDate: '2026-08-02' }))
      .toBe(`overdue_daily:${workspaceId}:${taskId}:${firstRecipientId}:2026-08-02`);
  });

  it('renders four generic Russian messages without supplied workspace secrets', () => {
    const sentinels = [
      'Сверхсекретное название',
      '4111111111111111',
      'https://vault.bitwarden.com/#/item-secret',
      'signed-upload-token',
    ];
    const rendered = (['assignment', 'mention', 'due_24h', 'overdue_daily'] as const)
      .map((kind) => renderNotification(kind, {
        botUsername: 'smoking_zen_bot',
        appShortName: 'workspace',
        taskId,
      }));
    const link = buildTaskDeepLink('smoking_zen_bot', 'workspace', taskId);

    expect(rendered.map(({ text }) => text)).toEqual([
      'Вам назначена задача.',
      'Вас упомянули в задаче.',
      'Срок задачи наступит в ближайшие 24 часа.',
      'У задачи истёк срок.',
    ]);
    expect(rendered.every(({ taskUrl }) => taskUrl === link)).toBe(true);
    for (const notification of rendered) {
      for (const sentinel of sentinels) expect(JSON.stringify(notification)).not.toContain(sentinel);
    }
  });

  it('builds only an exact validated Mini App task deep link', () => {
    expect(buildTaskDeepLink('smoking_zen_bot', 'workspace', taskId))
      .toBe(`https://t.me/smoking_zen_bot/workspace?startapp=task_${taskId}`);
    expect(() => buildTaskDeepLink('bad/name_bot', 'workspace', taskId)).toThrow('Invalid Telegram Mini App identity.');
    expect(() => buildTaskDeepLink('smoking_zen_bot', '../workspace', taskId)).toThrow('Invalid Telegram Mini App identity.');
    expect(() => buildTaskDeepLink('smoking_zen_bot', 'workspace', 'not-a-uuid')).toThrow('Invalid task identifier.');
  });

  it('builds an exact conservative invitation Mini App link', () => {
    const token = 'A'.repeat(42) + '_';
    expect(buildInviteDeepLink('smoking_zen_bot', 'workspace', token))
      .toBe(`https://t.me/smoking_zen_bot/workspace?startapp=invite_${token}`);
    expect(`invite_${token}`).toHaveLength(50);
    expect(() => buildInviteDeepLink('smoking_zen_bot', 'workspace', `${token}A`)).toThrow();
    expect(() => buildInviteDeepLink('smoking_zen_bot', 'workspace', `${'A'.repeat(42)}+`)).toThrow();
  });

  it('enforces Telegram bot and Mini App identifier boundaries and casing', () => {
    expect(buildTaskDeepLink('a_bot', 'app', taskId))
      .toBe(`https://t.me/a_bot/app?startapp=task_${taskId}`);
    expect(buildTaskDeepLink(`${'a'.repeat(29)}bot`, `a${'b'.repeat(29)}`, taskId))
      .toBe(`https://t.me/${'a'.repeat(29)}bot/a${'b'.repeat(29)}?startapp=task_${taskId}`);
    expect(buildTaskDeepLink('MixedCaseBot', 'lower_case_1', taskId))
      .toBe(`https://t.me/MixedCaseBot/lower_case_1?startapp=task_${taskId}`);

    for (const username of ['bot', `${'a'.repeat(30)}bot`, 'not-a-bot']) {
      expect(() => buildTaskDeepLink(username, 'app', taskId)).toThrow('Invalid Telegram Mini App identity.');
    }
    for (const shortName of ['ab', `a${'b'.repeat(30)}`, 'UpperCase']) {
      expect(() => buildTaskDeepLink('a_bot', shortName, taskId)).toThrow('Invalid Telegram Mini App identity.');
    }
  });

  it('does not accept a caller-supplied secret-bearing task URL through renderer fields', () => {
    const unsafeFields = [
      { botUsername: 'a_bot?token=sentinel', appShortName: 'app', taskId },
      { botUsername: 'a_bot', appShortName: 'app/secret', taskId },
      { botUsername: 'a_bot', appShortName: 'app', taskId: `${taskId}&token=sentinel` },
    ];

    for (const fields of unsafeFields) {
      expect(() => renderNotification('assignment', fields)).toThrow();
    }
  });
});
