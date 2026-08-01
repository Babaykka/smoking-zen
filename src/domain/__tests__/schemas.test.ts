import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  contactInputSchema,
  prioritySchema,
  safeMetadataSchema,
  secureItemInputSchema,
  taskInputSchema,
} from '@/domain/schemas';

describe('workspace schemas', () => {
  it.each([1, 2, 3, 4, 5])('accepts priority P%s', (priority) => {
    expect(prioritySchema.parse(priority)).toBe(priority);
  });

  it.each([0, 6, 2.5])('rejects a priority outside P1 through P5', (priority) => {
    expect(() => prioritySchema.parse(priority)).toThrow();
  });

  it('defaults a new task to P3', () => {
    expect(taskInputSchema.parse({ title: 'Проверить угли' }).priority).toBe(3);
  });

  it('rejects password and complete card values in secure metadata', () => {
    expect(() =>
      secureItemInputSchema.parse({
        title: 'Касса',
        externalUrl: 'https://vault.bitwarden.com/#/items/123',
        metadata: { password: 'not-allowed' },
      }),
    ).toThrow();
    expect(() =>
      secureItemInputSchema.parse({
        title: 'Касса',
        externalUrl: 'https://vault.bitwarden.com/#/items/123',
        metadata: { cardNumber: '4242 4242 4242 4242' },
      }),
    ).toThrow();
  });

  it.each([
    { пароль: 'нельзя' },
    { секрет: 'нельзя' },
    { токен: 'нельзя' },
    { пин: '1234' },
    { 'код подтверждения': '123456' },
    { label: 4242424242424242 },
  ])('rejects sensitive Russian keys and numeric PAN metadata: %o', (metadata) => {
    expect(safeMetadataSchema.safeParse(metadata).success).toBe(false);
  });

  it('allows a masked last four digits value', () => {
    expect(safeMetadataSchema.parse({ last4: '4242' })).toEqual({ last4: '4242' });
  });

  it('returns a Russian validation error instead of throwing for malformed safe URLs', () => {
    const result = secureItemInputSchema.safeParse({
      title: 'Касса',
      externalUrl: 'это не URL',
      metadata: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Укажите корректную HTTPS-ссылку Bitwarden.');
    }
  });

  it('accepts a contact with phone, Telegram, and WhatsApp methods', () => {
    expect(
      contactInputSchema.parse({
        name: 'Илья',
        methods: [
          { kind: 'phone', value: '+79990000000' },
          { kind: 'telegram', value: '@ilya' },
          { kind: 'whatsapp', value: '+79990000000' },
        ],
      }),
    ).toMatchObject({ name: 'Илья', methods: [{ kind: 'phone' }, { kind: 'telegram' }, { kind: 'whatsapp' }] });
  });

  it('accepts attachment metadata at the 25 MiB limit and rejects one byte over it', () => {
    const attachment = {
      id: 'attachment-1',
      name: 'menu.pdf',
      mimeType: 'application/pdf',
      size: MAX_ATTACHMENT_BYTES,
    };

    expect(taskInputSchema.parse({ title: 'Обновить меню', attachments: [attachment] }).attachments).toEqual([
      attachment,
    ]);
    expect(() =>
      taskInputSchema.parse({
        title: 'Обновить меню',
        attachments: [{ ...attachment, size: MAX_ATTACHMENT_BYTES + 1 }],
      }),
    ).toThrow();
  });
});
