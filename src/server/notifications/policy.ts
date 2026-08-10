export const notificationKinds = ['assignment', 'mention', 'due_24h', 'overdue_daily'] as const;
export type NotificationKind = (typeof notificationKinds)[number];

type TaskScopedKey = {
  workspaceId: string;
  taskId: string;
  recipientId: string;
};

type DueKeyInput = TaskScopedKey & { dueAt: string };
type OverdueKeyInput = TaskScopedKey & { localDate: string };
export type TaskLinkTarget = { botUsername: string; appShortName: string; taskId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const botUsernamePattern = /^(?=.{5,32}$)[A-Za-z0-9_]+bot$/iu;
const shortNamePattern = /^(?=.{3,30}$)[a-z][a-z0-9_]*$/u;
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const inviteTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const dueInstantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw new Error('Invalid notification identifier.');
  return value;
}

export function assignmentNotificationKey(eventId: string, recipientId: string): string {
  return `assignment:${requireUuid(eventId)}:${requireUuid(recipientId)}`;
}

export function mentionNotificationKey(eventId: string, recipientId: string): string {
  return `mention:${requireUuid(eventId)}:${requireUuid(recipientId)}`;
}

export function dueNotificationKey(input: DueKeyInput): string {
  const match = dueInstantPattern.exec(input.dueAt);
  if (!match) throw new Error('Invalid due timestamp.');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, sign, offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
  ].map(Number);
  const local = new Date(0);
  local.setUTCFullYear(year!, month! - 1, day!);
  local.setUTCHours(hour!, minute!, second!, 0);
  const validCalendar = local.getUTCFullYear() === year
    && local.getUTCMonth() === month! - 1
    && local.getUTCDate() === day
    && local.getUTCHours() === hour
    && local.getUTCMinutes() === minute
    && local.getUTCSeconds() === second;
  const offsetHours = zone === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinutes = zone === 'Z' ? 0 : Number(offsetMinuteText);
  if (!validCalendar || offsetHours > 23 || offsetMinutes > 59) {
    throw new Error('Invalid due timestamp.');
  }
  const offsetDirection = sign === '-' ? -1 : 1;
  const offsetSeconds = offsetDirection * ((offsetHours * 60 + offsetMinutes) * 60);
  const epochSeconds = BigInt(Math.trunc(local.getTime() / 1_000) - offsetSeconds);
  const microseconds = BigInt(fraction.padEnd(6, '0'));
  const epochMicroseconds = epochSeconds * 1_000_000n + microseconds;
  return `due_24h:${requireUuid(input.workspaceId)}:${requireUuid(input.taskId)}:${requireUuid(input.recipientId)}:${epochMicroseconds}`;
}

export function overdueNotificationKey(input: OverdueKeyInput): string {
  if (!localDatePattern.test(input.localDate)) throw new Error('Invalid Moscow local date.');
  return `overdue_daily:${requireUuid(input.workspaceId)}:${requireUuid(input.taskId)}:${requireUuid(input.recipientId)}:${input.localDate}`;
}

export function moscowLocalDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid notification clock.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function buildTaskDeepLink(botUsername: string, appShortName: string, taskId: string): string {
  if (!botUsernamePattern.test(botUsername) || !shortNamePattern.test(appShortName)) {
    throw new Error('Invalid Telegram Mini App identity.');
  }
  if (!uuidPattern.test(taskId)) throw new Error('Invalid task identifier.');
  return `https://t.me/${botUsername}/${appShortName}?startapp=task_${taskId}`;
}

export function buildInviteDeepLink(botUsername: string, appShortName: string, token: string): string {
  if (!botUsernamePattern.test(botUsername) || !shortNamePattern.test(appShortName)) {
    throw new Error('Invalid Telegram Mini App identity.');
  }
  if (!inviteTokenPattern.test(token)) throw new Error('Invalid invitation token.');
  return `https://t.me/${botUsername}/${appShortName}?startapp=invite_${token}`;
}

const notificationText: Record<NotificationKind, string> = {
  assignment: 'Вам назначена задача.',
  mention: 'Вас упомянули в задаче.',
  due_24h: 'Срок задачи наступит в ближайшие 24 часа.',
  overdue_daily: 'У задачи истёк срок.',
};

export function renderNotification(kind: NotificationKind, target: TaskLinkTarget): { text: string; taskUrl: string } {
  return {
    text: notificationText[kind],
    taskUrl: buildTaskDeepLink(target.botUsername, target.appShortName, target.taskId),
  };
}
