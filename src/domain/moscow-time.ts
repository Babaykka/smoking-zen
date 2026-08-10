const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const MOSCOW_OFFSET = '+03:00';
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const localDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const displayFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: MOSCOW_TIME_ZONE,
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

function parts(formatter: Intl.DateTimeFormat, value: Date): Record<string, string> {
  return Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
}

export function moscowDateKey(value: Date): string {
  const valueParts = parts(dateKeyFormatter, value);
  return `${valueParts.year}-${valueParts.month}-${valueParts.day}`;
}

export function toMoscowDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error('Некорректный срок задачи.');
  const valueParts = parts(localDateTimeFormatter, date);
  return `${valueParts.year}-${valueParts.month}-${valueParts.day}T${valueParts.hour}:${valueParts.minute}`;
}

export function fromMoscowDateTimeLocal(value: string): string {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new Error('Некорректный срок задачи.');
  const date = new Date(`${value}:00.000${MOSCOW_OFFSET}`);
  if (!Number.isFinite(date.getTime()) || toMoscowDateTimeLocal(date.toISOString()) !== value) {
    throw new Error('Некорректный срок задачи.');
  }
  return date.toISOString();
}

export function formatMoscowDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error('Некорректный срок задачи.');
  return displayFormatter.format(date).replace(' в ', ', ');
}
