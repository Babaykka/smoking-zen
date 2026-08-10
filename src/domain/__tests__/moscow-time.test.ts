import { describe, expect, it } from 'vitest';

import {
  formatMoscowDateTime,
  fromMoscowDateTimeLocal,
  moscowDateKey,
  toMoscowDateTimeLocal,
} from '@/domain/moscow-time';

describe('Europe/Moscow deadline handling', () => {
  it('stores datetime-local as an absolute instant and renders the same Moscow wall time', () => {
    expect(fromMoscowDateTimeLocal('2026-08-02T18:30')).toBe('2026-08-02T15:30:00.000Z');
    expect(toMoscowDateTimeLocal('2026-08-02T15:30:00.000Z')).toBe('2026-08-02T18:30');
    expect(formatMoscowDateTime('2026-08-02T15:30:00.000Z')).toBe('2 августа, 18:30');
  });

  it('uses the Moscow calendar day around the UTC boundary', () => {
    expect(moscowDateKey(new Date('2026-08-02T20:59:59.999Z'))).toBe('2026-08-02');
    expect(moscowDateKey(new Date('2026-08-02T21:00:00.000Z'))).toBe('2026-08-03');
  });

  it.each(['', '2026-02-30T18:30', '2026-08-02T25:00', '2026-08-02T18:30Z'])(
    'rejects invalid Moscow local input %j',
    (value) => expect(() => fromMoscowDateTimeLocal(value)).toThrow('Некорректный срок задачи.'),
  );
});
