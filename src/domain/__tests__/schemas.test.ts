import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  attachmentInputSchema,
  commentInputSchema,
  contactInputSchema,
  contactPatchSchema,
  knowledgeInputSchema,
  mergeKnowledgePatch,
  knowledgePatchSchema,
  prioritySchema,
  safeMetadataSchema,
  secureItemInputSchema,
  taskInputSchema,
} from '@/domain/schemas';
import { demoSeed } from '@/data/demo-seed';

describe('workspace schemas', () => {
  it('keeps knowledge and contact patches non-defaulting while validating secret-safe fields', () => {
    expect(knowledgePatchSchema.parse({ title: 'Новый заголовок' })).toEqual({ title: 'Новый заголовок' });
    expect(contactPatchSchema.parse({ name: 'Новый контакт' })).toEqual({ name: 'Новый контакт' });
    expect(knowledgePatchSchema.safeParse({ body: 'token=abc.def.ghi' }).success).toBe(false);
    expect(contactPatchSchema.safeParse({ notes: 'Карта 4242 4242 4242 4242' }).success).toBe(false);
    expect(knowledgePatchSchema.safeParse({ body: 'Пароль хранится в Bitwarden; токены не пишем в заметках.' }).success).toBe(true);
  });

  it('allows only explicit safe knowledge links and normalized contact methods', () => {
    expect(knowledgeInputSchema.parse({
      title: 'Регламент', kind: 'link', linkUrl: 'https://example.com/guide',
    }).linkUrl).toBe('https://example.com/guide');
    expect(knowledgeInputSchema.safeParse({ title: 'Опасно', kind: 'link', linkUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(knowledgeInputSchema.safeParse({ title: 'Опасно', kind: 'link', linkUrl: 'data:text/html,hello' }).success).toBe(false);
    expect(knowledgeInputSchema.safeParse({ title: 'Опасно', kind: 'link', linkUrl: 'https://user:pass@example.com' }).success).toBe(false);
    expect(knowledgeInputSchema.safeParse({ title: 'Опасно', kind: 'link', linkUrl: 'https://example.com/?token=abc' }).success).toBe(false);
    expect(knowledgeInputSchema.safeParse({ title: 'Опасно', kind: 'link', linkUrl: 'https://storage.example.com/?X-Amz-Signature=private' }).success).toBe(false);
    expect(contactInputSchema.parse({
      name: 'Илья',
      methods: [
        { kind: 'phone', value: '+7 (999) 000-00-00' },
        { kind: 'telegram', value: '@ilya_test' },
        { kind: 'whatsapp', value: '+7 (999) 000-00-00' },
      ],
    }).methods).toEqual([
      { kind: 'phone', value: '+79990000000' },
      { kind: 'telegram', value: 'ilya_test' },
      { kind: 'whatsapp', value: '79990000000' },
    ]);
    expect(contactInputSchema.safeParse({ name: 'Илья', methods: [{ kind: 'telegram', value: 'javascript:alert(1)' }] }).success).toBe(false);
  });

  it('keeps link URLs and contact method validation type-specific', () => {
    expect(knowledgeInputSchema.safeParse({ title: 'Ссылка', kind: 'link' }).success).toBe(false);
    expect(knowledgeInputSchema.parse({ title: 'Заметка', kind: 'note', linkUrl: 'https://example.com' }).linkUrl).toBeNull();
    expect(contactInputSchema.safeParse({ name: 'Телефон', methods: [{ kind: 'phone', value: '+123456789012345' }] }).success).toBe(true);
    expect(contactInputSchema.safeParse({ name: 'Телефон', methods: [{ kind: 'phone', value: '+1234567890123456' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Телеграм', methods: [{ kind: 'telegram', value: '@ilya' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Телеграм', methods: [{ kind: 'telegram', value: '@ilya_test' }] }).success).toBe(true);
  });

  it('rejects raw credentials and PAN values in every contact method without blocking E.164 phones', () => {
    expect(contactInputSchema.safeParse({ name: 'PAN phone', methods: [{ kind: 'phone', value: '378282246310005' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'PAN Telegram', methods: [{ kind: 'telegram', value: '378282246310005' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'PAN WhatsApp', methods: [{ kind: 'whatsapp', value: '378282246310005' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Credential phone', methods: [{ kind: 'phone', value: 'password: 1234567' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Credential Telegram', methods: [{ kind: 'telegram', value: 'token=1234567' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Credential WhatsApp', methods: [{ kind: 'whatsapp', value: 'password: 1234567' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Confirmation phone', methods: [{ kind: 'phone', value: 'confirmation code: 1234567' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Confirmation Telegram', methods: [{ kind: 'telegram', value: 'confirmation code: 1234567' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'Confirmation WhatsApp', methods: [{ kind: 'whatsapp', value: 'confirmation code: 1234567' }] }).success).toBe(false);
    expect(contactInputSchema.safeParse({ name: 'E.164 13', methods: [{ kind: 'phone', value: '+1234567890123' }] }).success).toBe(true);
    expect(contactInputSchema.safeParse({ name: 'E.164 15', methods: [{ kind: 'phone', value: '+378282246310005' }] }).success).toBe(true);
    expect(contactInputSchema.parse({ name: 'WhatsApp E.164 15', methods: [{ kind: 'whatsapp', value: '+378282246310005' }] }).methods)
      .toEqual([{ kind: 'whatsapp', value: '378282246310005' }]);
  });

  it('requires deterministic knowledge patch transitions', () => {
    const note = { title: 'Заметка', body: '', kind: 'note' as const, linkUrl: null, sectionId: null, attachments: [] };
    const link = { ...note, kind: 'link' as const, linkUrl: 'https://example.com/old' };
    expect(() => mergeKnowledgePatch(note, { kind: 'link' })).toThrow();
    expect(() => mergeKnowledgePatch(note, { linkUrl: 'https://example.com/guide' })).toThrow();
    expect(mergeKnowledgePatch(note, { kind: 'link', linkUrl: 'https://example.com/guide' })).toMatchObject({
      kind: 'link', linkUrl: 'https://example.com/guide',
    });
    expect(mergeKnowledgePatch(link, { linkUrl: 'https://example.com/new' })).toMatchObject({
      kind: 'link', linkUrl: 'https://example.com/new',
    });
    expect(mergeKnowledgePatch(link, { kind: 'note' })).toMatchObject({ kind: 'note', linkUrl: null });
    expect(knowledgePatchSchema.safeParse({ kind: 'link' }).success).toBe(true);
    expect(knowledgePatchSchema.safeParse({ linkUrl: 'https://example.com/guide' }).success).toBe(true);
    expect(knowledgePatchSchema.safeParse({ kind: 'link', linkUrl: 'https://example.com/guide' }).success).toBe(true);
    expect(knowledgePatchSchema.safeParse({ kind: 'note' }).success).toBe(true);
    expect(knowledgePatchSchema.safeParse({ kind: 'note', linkUrl: null }).success).toBe(true);
  });

  it('exposes the exact eight canonical sections in the demo seed', () => {
    expect(demoSeed.sections.map((section) => section.name)).toEqual([
      'Открытие',
      'Ремонт и техника',
      'Закупки и склад',
      'Зал и сервис',
      'Персонал',
      'Маркетинг',
      'Документы и финансы',
      'Безопасность и санитария',
    ]);
  });

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

  it.each([
    'password: hunter2',
    'пароль: hunter2',
    'token=abc.def.ghi',
    'OTP: 123456',
    'OTP 123456',
    'one-time password: 123456',
    'пин: 1234',
    'пароль hunter2',
    'код подтверждения: 123456',
  ])('rejects an explicit credential in a metadata value: %s', (note) => {
    expect(safeMetadataSchema.safeParse({ note }).success).toBe(false);
  });

  it('allows harmless metadata prose about security policies', () => {
    expect(
      safeMetadataSchema.parse({
        note: 'Пароль хранится в Bitwarden; не отправляйте токены в чат.',
        policy: 'Подтверждение входа выполняется только в приложении.',
        englishPolicy: 'Password rotation is documented in the team policy.',
        russianPolicy: 'Политика смены пароля описана в регламенте команды.',
      }),
    ).toMatchObject({ note: expect.any(String), policy: expect.any(String) });
  });

  it('rejects explicit secrets and complete card numbers in task descriptions and comments', () => {
    expect(taskInputSchema.safeParse({ title: 'Смена', description: 'token=abc.def.ghi' }).success).toBe(false);
    expect(taskInputSchema.safeParse({ title: 'Касса', description: 'Карта 4242 4242 4242 4242' }).success).toBe(false);
    expect(commentInputSchema.safeParse({ taskId: 'task-1', authorId: 'member-1', body: 'пароль: hunter2' }).success).toBe(false);
  });

  it('allows harmless task and comment prose about credential policy', () => {
    expect(taskInputSchema.safeParse({ title: 'Регламент', description: 'Пароль хранится в Bitwarden; токены в чат не отправляем.' }).success).toBe(true);
    expect(commentInputSchema.safeParse({ taskId: 'task-1', authorId: 'member-1', body: 'Политика смены пароля обновлена.' }).success).toBe(true);
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

  it('returns concise Russian messages for task validation errors', () => {
    const emptyTitle = taskInputSchema.safeParse({ title: '' });
    const invalidDate = taskInputSchema.safeParse({ title: 'Смена', dueAt: 'tomorrow' });

    expect(emptyTitle.success).toBe(false);
    expect(invalidDate.success).toBe(false);
    if (!emptyTitle.success) expect(emptyTitle.error.issues[0]?.message).toBe('Введите название задачи.');
    if (!invalidDate.success) expect(invalidDate.error.issues[0]?.message).toBe('Укажите дату в формате ISO 8601.');
  });

  it('returns concise Russian messages for contact validation errors', () => {
    const emptyName = contactInputSchema.safeParse({ name: '', methods: [{ kind: 'phone', value: '+79990000000' }] });
    const noMethods = contactInputSchema.safeParse({ name: 'Илья', methods: [] });

    expect(emptyName.success).toBe(false);
    expect(noMethods.success).toBe(false);
    if (!emptyName.success) expect(emptyName.error.issues[0]?.message).toBe('Введите имя контакта.');
    if (!noMethods.success) expect(noMethods.error.issues[0]?.message).toBe('Добавьте хотя бы один способ связи.');
  });

  it('returns concise Russian messages for attachment validation errors', () => {
    const missingName = attachmentInputSchema.safeParse({ id: 'attachment-1', name: '', mimeType: 'application/pdf', size: 1 });
    const oversized = attachmentInputSchema.safeParse({ id: 'attachment-1', name: 'menu.pdf', mimeType: 'application/pdf', size: MAX_ATTACHMENT_BYTES + 1 });

    expect(missingName.success).toBe(false);
    expect(oversized.success).toBe(false);
    if (!missingName.success) expect(missingName.error.issues[0]?.message).toBe('Введите название файла.');
    if (!oversized.success) expect(oversized.error.issues[0]?.message).toBe('Размер файла не должен превышать 25 МиБ.');
  });

  it('returns a concise Russian message for a missing secure item title', () => {
    const result = secureItemInputSchema.safeParse({
      title: '',
      externalUrl: 'https://vault.bitwarden.com/#/items/123',
      metadata: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe('Введите название безопасной записи.');
  });

  it('returns Russian type and maximum-length messages for user-entered fields', () => {
    const taskType = taskInputSchema.safeParse({ title: 42 });
    const contactMaximum = contactInputSchema.safeParse({
      name: 'И'.repeat(281),
      methods: [{ kind: 'phone', value: '+79990000000' }],
    });
    const attachmentType = attachmentInputSchema.safeParse({
      id: 'attachment-1',
      name: 'menu.pdf',
      mimeType: 'application/pdf',
      size: '1',
    });
    const secureItemType = secureItemInputSchema.safeParse({
      title: 42,
      externalUrl: 'https://vault.bitwarden.com/#/items/123',
      metadata: {},
    });

    expect(taskType.success).toBe(false);
    expect(contactMaximum.success).toBe(false);
    expect(attachmentType.success).toBe(false);
    expect(secureItemType.success).toBe(false);
    if (!taskType.success) expect(taskType.error.issues[0]?.message).toBe('Название задачи должно быть текстом.');
    if (!contactMaximum.success) expect(contactMaximum.error.issues[0]?.message).toBe('Имя контакта слишком длинное.');
    if (!attachmentType.success) expect(attachmentType.error.issues[0]?.message).toBe('Размер файла должен быть числом.');
    if (!secureItemType.success) expect(secureItemType.error.issues[0]?.message).toBe('Название безопасной записи должно быть текстом.');
  });

  it('returns Russian container errors for nested user input', () => {
    const attachmentObject = attachmentInputSchema.safeParse(null);
    const taskAttachment = taskInputSchema.safeParse({ title: 'Смена', attachments: [null] });
    const taskAttachments = taskInputSchema.safeParse({ title: 'Смена', attachments: 'не список' });
    const contactMethod = contactInputSchema.safeParse({ name: 'Илья', methods: [null] });
    const contactMethods = contactInputSchema.safeParse({ name: 'Илья', methods: 'не список' });
    const secureMetadata = secureItemInputSchema.safeParse({
      title: 'Касса',
      externalUrl: 'https://vault.bitwarden.com/#/items/123',
      metadata: 'не объект',
    });

    expect(attachmentObject.success).toBe(false);
    expect(taskAttachment.success).toBe(false);
    expect(taskAttachments.success).toBe(false);
    expect(contactMethod.success).toBe(false);
    expect(contactMethods.success).toBe(false);
    expect(secureMetadata.success).toBe(false);
    if (!attachmentObject.success) expect(attachmentObject.error.issues[0]?.message).toBe('Вложение должно быть объектом.');
    if (!taskAttachment.success) expect(taskAttachment.error.issues[0]?.message).toBe('Вложение должно быть объектом.');
    if (!taskAttachments.success) expect(taskAttachments.error.issues[0]?.message).toBe('Вложения должны быть списком.');
    if (!contactMethod.success) expect(contactMethod.error.issues[0]?.message).toBe('Способ связи должен быть объектом.');
    if (!contactMethods.success) expect(contactMethods.error.issues[0]?.message).toBe('Способы связи должны быть списком.');
    if (!secureMetadata.success) expect(secureMetadata.error.issues[0]?.message).toBe('Метаданные должны быть объектом.');
  });

  it('accepts a contact with phone, Telegram, and WhatsApp methods', () => {
    expect(
      contactInputSchema.parse({
        name: 'Илья',
        methods: [
          { kind: 'phone', value: '+79990000000' },
          { kind: 'telegram', value: '@ilya_test' },
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
