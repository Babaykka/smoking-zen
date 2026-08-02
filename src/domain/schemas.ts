import { z } from 'zod';

import type { ContactCategory, ContactMethodKind, KnowledgeKind, Priority } from '@/domain/types';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const prioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
], 'Выберите приоритет от P1 до P5.');

const idSchema = (label: string) => z
  .string({ error: `${label} должно быть текстом.` })
  .trim()
  .min(1, `${label} не может быть пустым.`)
  .max(200, `${label} слишком длинное.`);

const nullableIdSchema = idSchema('Значение').nullable().optional();
const optionalTextSchema = z.string({ error: 'Заметка должна быть текстом.' }).trim().max(10_000, 'Заметка слишком длинная.').optional();
const secretLikeText = /(?:\b(?:password|passphrase|secret|token|pin|cvv|cvc|otp)\b|пароль|секрет|токен|пин|(?:код\s*)?подтвержден\p{L}*)(?:\s*(?:[:=]|[-–—])\s*|\s+(?=\S*(?:\d|[._~+/=-])))\S+/iu;

export function containsSecretLikeText(value: string): boolean {
  return secretLikeText.test(value) || /\d(?:[ -]*\d){12,18}/.test(value);
}

const safeFreeText = (schema: z.ZodString) => schema.refine(
  (value) => !containsSecretLikeText(value),
  'Секретные данные и реквизиты карт хранить нельзя.',
);

const safeKnowledgeUrlSchema = z.string({ error: 'Укажите корректную HTTPS-ссылку.' }).trim().max(2_000, 'Ссылка слишком длинная.').refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      [...url.searchParams.keys()].every((key) => !/(?:token|signature|credential|secret|password|x-amz-)/iu.test(key));
  } catch {
    return false;
  }
}, 'Укажите корректную HTTPS-ссылку.');

function normalizeContactMethod(kind: ContactMethodKind, value: string): string | null {
  if (kind === 'phone') {
    const normalized = value.replace(/[\s().-]/g, '');
    return /^\+?\d{7,15}$/.test(normalized) ? `+${normalized.replace(/^\+/, '')}` : null;
  }
  if (kind === 'telegram') {
    const username = value.replace(/^@/, '');
    return /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null;
  }
  const digits = value.replace(/\D/g, '');
  return /^\d{7,15}$/.test(digits) ? digits : null;
}

export const attachmentInputSchema = z
  .object({
    id: idSchema('Идентификатор файла'),
    name: z.string({ error: 'Название файла должно быть текстом.' }).trim().min(1, 'Введите название файла.').max(255, 'Название файла слишком длинное.'),
    mimeType: z.string({ error: 'Тип файла должен быть текстом.' }).trim().min(1, 'Укажите тип файла.').max(200, 'Тип файла слишком длинный.'),
    size: z.number({ error: 'Размер файла должен быть числом.' }).int('Размер файла должен быть целым числом.').nonnegative('Размер файла не может быть отрицательным.').max(MAX_ATTACHMENT_BYTES, 'Размер файла не должен превышать 25 МиБ.'),
    storagePath: z.string({ error: 'Путь к файлу должен быть текстом.' }).trim().min(1, 'Путь к файлу не может быть пустым.').max(1_000, 'Путь к файлу слишком длинный.').optional(),
  }, { error: 'Вложение должно быть объектом.' })
  .strict();

export const taskInputSchema = z
  .object({
    title: z.string({ error: 'Название задачи должно быть текстом.' }).trim().min(1, 'Введите название задачи.').max(280, 'Название задачи слишком длинное.').refine((value) => !containsSecretLikeText(value), 'Секретные данные и реквизиты карт хранить нельзя.'),
    description: safeFreeText(z.string({ error: 'Описание задачи должно быть текстом.' }).trim().max(20_000, 'Описание задачи слишком длинное.')).default(''),
    priority: prioritySchema.default(3),
    statusId: idSchema('Статус').optional(),
    sectionId: nullableIdSchema.default(null),
    assigneeId: nullableIdSchema.default(null),
    dueAt: z.string({ error: 'Укажите дату в формате ISO 8601.' }).datetime({ offset: true, error: 'Укажите дату в формате ISO 8601.' }).nullable().optional().default(null),
    attachments: z.array(attachmentInputSchema, { error: 'Вложения должны быть списком.' }).max(20, 'Можно добавить не более 20 вложений.').default([]),
  }, { error: 'Данные задачи должны быть объектом.' })
  .strict();

export const taskPatchSchema = z
  .object({
    title: z.string({ error: 'Название задачи должно быть текстом.' }).trim().min(1, 'Введите название задачи.').max(280, 'Название задачи слишком длинное.').refine((value) => !containsSecretLikeText(value), 'Секретные данные и реквизиты карт хранить нельзя.').optional(),
    description: safeFreeText(z.string({ error: 'Описание задачи должно быть текстом.' }).trim().max(20_000, 'Описание задачи слишком длинное.')).optional(),
    priority: prioritySchema.optional(),
    statusId: idSchema('Статус').optional(),
    sectionId: nullableIdSchema,
    assigneeId: nullableIdSchema,
    dueAt: z.string({ error: 'Укажите дату в формате ISO 8601.' }).datetime({ offset: true, error: 'Укажите дату в формате ISO 8601.' }).nullable().optional(),
    attachments: z.array(attachmentInputSchema, { error: 'Вложения должны быть списком.' }).max(20, 'Можно добавить не более 20 вложений.').optional(),
  }, { error: 'Изменения задачи должны быть объектом.' })
  .strict();

export const commentInputSchema = z
  .object({
    taskId: idSchema('Идентификатор задачи'),
    authorId: idSchema('Идентификатор автора'),
    body: safeFreeText(z.string({ error: 'Комментарий должен быть текстом.' }).trim().min(1, 'Введите комментарий.').max(10_000, 'Комментарий слишком длинный.')),
  }, { error: 'Комментарий должен быть объектом.' })
  .strict();

export const knowledgeInputSchema = z
  .object({
    title: safeFreeText(z.string({ error: 'Название материала должно быть текстом.' }).trim().min(1, 'Введите название материала.').max(280, 'Название материала слишком длинное.')),
    body: safeFreeText(z.string({ error: 'Содержание должно быть текстом.' }).trim().max(30_000, 'Содержание слишком длинное.')).default(''),
    kind: z.enum(['note', 'instruction', 'document', 'link'] satisfies [KnowledgeKind, ...KnowledgeKind[]], { error: 'Выберите тип материала.' }),
    linkUrl: safeKnowledgeUrlSchema.nullable().optional().default(null),
    sectionId: nullableIdSchema.default(null),
    attachments: z.array(attachmentInputSchema, { error: 'Вложения должны быть списком.' }).max(20, 'Можно добавить не более 20 вложений.').default([]),
  }, { error: 'Материал должен быть объектом.' })
  .strict()
  .superRefine((item, context) => {
    if (item.kind === 'link' && !item.linkUrl) {
      context.addIssue({ code: 'custom', message: 'Для ссылки укажите HTTPS-адрес.', path: ['linkUrl'] });
    }
  })
  .transform((item) => item.kind === 'link' ? item : { ...item, linkUrl: null });

export const knowledgePatchSchema = z.object({
  title: safeFreeText(z.string({ error: 'Название материала должно быть текстом.' }).trim().min(1, 'Введите название материала.').max(280, 'Название материала слишком длинное.')).optional(),
  body: safeFreeText(z.string({ error: 'Содержание должно быть текстом.' }).trim().max(30_000, 'Содержание слишком длинное.')).optional(),
  kind: z.enum(['note', 'instruction', 'document', 'link'] satisfies [KnowledgeKind, ...KnowledgeKind[]], { error: 'Выберите тип материала.' }).optional(),
  linkUrl: safeKnowledgeUrlSchema.nullable().optional(),
  sectionId: nullableIdSchema,
  attachments: z.array(attachmentInputSchema, { error: 'Вложения должны быть списком.' }).max(20, 'Можно добавить не более 20 вложений.').optional(),
}, { error: 'Изменения материала должны быть объектом.' }).strict();

export const contactMethodSchema = z
  .object({
    kind: z.enum(['phone', 'telegram', 'whatsapp'] satisfies [ContactMethodKind, ...ContactMethodKind[]], { error: 'Выберите способ связи.' }),
    value: z.string({ error: 'Контакт должен быть текстом.' }).trim().min(1, 'Введите контакт.').max(300, 'Контакт слишком длинный.'),
  }, { error: 'Способ связи должен быть объектом.' })
  .strict()
  .transform((method, context) => {
    const value = normalizeContactMethod(method.kind, method.value);
    if (!value) {
      context.addIssue({ code: 'custom', message: 'Укажите корректный способ связи.', path: ['value'] });
      return z.NEVER;
    }
    return { ...method, value };
  });

export const contactInputSchema = z
  .object({
    name: safeFreeText(z.string({ error: 'Имя контакта должно быть текстом.' }).trim().min(1, 'Введите имя контакта.').max(280, 'Имя контакта слишком длинное.')),
    category: z.enum(['supplier', 'service', 'landlord', 'cleaning', 'other'] satisfies [
      ContactCategory,
      ...ContactCategory[],
    ], { error: 'Выберите категорию контакта.' }).default('other'),
    notes: optionalTextSchema.refine((value) => value === undefined || !containsSecretLikeText(value), 'Секретные данные и реквизиты карт хранить нельзя.').default(''),
    methods: z.array(contactMethodSchema, { error: 'Способы связи должны быть списком.' }).min(1, 'Добавьте хотя бы один способ связи.').max(10, 'Можно добавить не более 10 способов связи.'),
  }, { error: 'Контакт должен быть объектом.' })
  .strict();

export const contactPatchSchema = z.object({
  name: safeFreeText(z.string({ error: 'Имя контакта должно быть текстом.' }).trim().min(1, 'Введите имя контакта.').max(280, 'Имя контакта слишком длинное.')).optional(),
  category: z.enum(['supplier', 'service', 'landlord', 'cleaning', 'other'] satisfies [ContactCategory, ...ContactCategory[]], { error: 'Выберите категорию контакта.' }).optional(),
  notes: optionalTextSchema.refine((value) => value === undefined || !containsSecretLikeText(value), 'Секретные данные и реквизиты карт хранить нельзя.'),
  methods: z.array(contactMethodSchema, { error: 'Способы связи должны быть списком.' }).min(1, 'Добавьте хотя бы один способ связи.').max(10, 'Можно добавить не более 10 способов связи.').optional(),
}, { error: 'Изменения контакта должны быть объектом.' }).strict();

const safeMetadataValueSchema = z.union([
  z.string({ error: 'Значение метаданных должно быть строкой, числом, логическим значением или пустым.' }).max(2_000, 'Значение метаданных слишком длинное.'),
  z.number({ error: 'Значение метаданных должно быть строкой, числом, логическим значением или пустым.' }).finite('Число в метаданных должно быть конечным.'),
  z.boolean({ error: 'Значение метаданных должно быть строкой, числом, логическим значением или пустым.' }),
  z.null(),
]);

const sensitiveMetadataKey = /(?:password|пароль|passphrase|secret|секрет|token|токен|pin|пин|cvv|cvc|otp|(?:код\s*)?подтвержден\p{L}*|confirmation\s*(?:code)?|card(?:number)?|pan)/iu;
const explicitCredentialValue = secretLikeText;

function containsPanLikeSequence(value: string | number) {
  const compact = String(value).replace(/\D/g, '');

  return /\d{13,19}/.test(compact);
}

function isBitwardenUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'bitwarden.com' || url.hostname.endsWith('.bitwarden.com'));
  } catch {
    return false;
  }
}

export const safeMetadataSchema = z
  .record(z.string().trim().min(1, 'Название поля метаданных не может быть пустым.').max(100, 'Название поля метаданных слишком длинное.'), safeMetadataValueSchema, { error: 'Метаданные должны быть объектом.' })
  .superRefine((metadata, context) => {
    for (const [key, value] of Object.entries(metadata)) {
      if (sensitiveMetadataKey.test(key)) {
        context.addIssue({ code: 'custom', message: 'Секретные данные и реквизиты карт хранить нельзя.', path: [key] });
      }
      if ((typeof value === 'string' || typeof value === 'number') && containsPanLikeSequence(value)) {
        context.addIssue({ code: 'custom', message: 'Полный номер карты хранить нельзя.', path: [key] });
      }
      if (typeof value === 'string' && explicitCredentialValue.test(value)) {
        context.addIssue({ code: 'custom', message: 'Секретные данные и реквизиты карт хранить нельзя.', path: [key] });
      }
    }
  });

export const secureItemInputSchema = z
  .object({
    title: z.string({ error: 'Название безопасной записи должно быть текстом.' }).trim().min(1, 'Введите название безопасной записи.').max(280, 'Название безопасной записи слишком длинное.'),
    externalUrl: z
      .string({ error: 'Укажите корректную HTTPS-ссылку Bitwarden.' })
      .trim()
      .min(1, 'Укажите корректную HTTPS-ссылку Bitwarden.')
      .refine(isBitwardenUrl, 'Укажите корректную HTTPS-ссылку Bitwarden.'),
    metadata: safeMetadataSchema.default({}),
  }, { error: 'Безопасная запись должна быть объектом.' })
  .strict();

export type TaskInput = z.input<typeof taskInputSchema>;
export type TaskPatchInput = z.input<typeof taskPatchSchema>;
export type CommentInput = z.input<typeof commentInputSchema>;
export type KnowledgeInput = z.input<typeof knowledgeInputSchema>;
export type KnowledgePatchInput = z.input<typeof knowledgePatchSchema>;
export type ContactInput = z.input<typeof contactInputSchema>;
export type ContactPatchInput = z.input<typeof contactPatchSchema>;
export type SecureItemInput = z.input<typeof secureItemInputSchema>;
export type ParsedTaskInput = z.output<typeof taskInputSchema>;
export type ParsedTaskPatchInput = z.output<typeof taskPatchSchema>;
export type ParsedCommentInput = z.output<typeof commentInputSchema>;
export type ParsedKnowledgeInput = z.output<typeof knowledgeInputSchema>;
export type ParsedKnowledgePatchInput = z.output<typeof knowledgePatchSchema>;
export type ParsedContactInput = z.output<typeof contactInputSchema>;
export type ParsedContactPatchInput = z.output<typeof contactPatchSchema>;
export type ParsedSecureItemInput = z.output<typeof secureItemInputSchema>;

export const DEFAULT_PRIORITY: Priority = 3;
