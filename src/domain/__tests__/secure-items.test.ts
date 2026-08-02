import { describe, expect, it } from 'vitest';

import {
  createSecureItemInputSchema,
  createSecureItemPatchSchema,
  secureItemInputSchema,
  secureItemPatchSchema,
} from '@/domain/schemas';

const validItem = {
  title: 'Касса',
  purpose: 'Доступ к рабочей кассе',
  owner: 'Управляющий',
  reviewDate: '2026-09-01',
  cardBank: 'Тестовый банк',
  cardHolder: 'SMOKING ZEN',
  cardPurpose: 'Операционные расходы',
  lastFour: '0000',
  externalUrl: 'https://vault.bitwarden.com/#/items/example',
};

describe('secure item schemas', () => {
  it.each([
    'https://vault.bitwarden.com/#/items/example',
    'https://vault.bitwarden.eu/#/items/example',
  ])('accepts the exact built-in Bitwarden vault origin %s', (externalUrl) => {
    expect(secureItemInputSchema.parse({ ...validItem, externalUrl })).toMatchObject({
      externalUrl,
      lastFour: '0000',
    });
  });

  it.each([
    'http://vault.bitwarden.com/#/items/example',
    'https://bitwarden.com/#/items/example',
    'https://evil.vault.bitwarden.com/#/items/example',
    'https://vault.bitwarden.com.evil.example/#/items/example',
    'https://user:password@vault.bitwarden.com/#/items/example',
    'https://vault.bitwarden.com:8443/#/items/example',
    'https://vault.bitwarden.com/?token=secret#/items/example',
    'javascript:alert(1)',
  ])('rejects an unsafe Bitwarden URL %s', (externalUrl) => {
    expect(secureItemInputSchema.safeParse({ ...validItem, externalUrl }).success).toBe(false);
  });

  it('allows a self-hosted origin only through an exact server allowlist', () => {
    const allowed = createSecureItemInputSchema(['https://vault.example.org']);
    expect(allowed.safeParse({ ...validItem, externalUrl: 'https://vault.example.org/#/items/1' }).success).toBe(true);
    expect(allowed.safeParse({ ...validItem, externalUrl: 'https://sub.vault.example.org/#/items/1' }).success).toBe(false);
    expect(allowed.safeParse({ ...validItem, externalUrl: 'https://vault.example.org:8443/#/items/1' }).success).toBe(false);
  });

  it('uses strict flat fields, preserves string last-four digits, and keeps patches non-defaulting', () => {
    expect(secureItemInputSchema.safeParse({ ...validItem, metadata: {} }).success).toBe(false);
    expect(secureItemInputSchema.safeParse({ ...validItem, card: { lastFour: '4242' } }).success).toBe(false);
    expect(secureItemInputSchema.safeParse({ ...validItem, lastFour: 0 }).success).toBe(false);
    expect(secureItemInputSchema.safeParse({ ...validItem, lastFour: '123' }).success).toBe(false);
    expect(secureItemPatchSchema.parse({ owner: 'Старший смены' })).toEqual({ owner: 'Старший смены' });
    expect(createSecureItemPatchSchema([]).parse({ externalUrl: 'https://vault.bitwarden.eu/#/items/new' }))
      .toEqual({ externalUrl: 'https://vault.bitwarden.eu/#/items/new' });
  });

  it.each([
    ['title', 'password: hunter2'],
    ['purpose', 'token=abc.def.ghi'],
    ['owner', 'пин: 1234'],
    ['cardBank', 'OTP: 123456'],
    ['cardHolder', '4242 4242 4242 4242'],
    ['cardPurpose', 'код подтверждения: 123456'],
  ] as const)('rejects secret or PAN content in persisted field %s', (field, value) => {
    expect(secureItemInputSchema.safeParse({ ...validItem, [field]: value }).success).toBe(false);
  });

  it('allows harmless policy prose without weakening credential detection', () => {
    expect(secureItemInputSchema.safeParse({
      ...validItem,
      purpose: 'Пароль хранится в Bitwarden; токены в рабочие заметки не копируются.',
      cardBank: null,
      cardHolder: null,
      cardPurpose: null,
      lastFour: null,
    }).success).toBe(true);
  });
});
