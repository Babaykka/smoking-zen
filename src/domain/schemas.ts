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
const SAFE_SCAN_ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/gu;
const SAFE_SCAN_SEPARATORS = /[\p{Pd}+:\/_\.=]+/gu;
const secretLikeText = /(?:^|[^\p{L}\p{N}])(?:password|passphrase|secret|token|credential|pin|cvv|cvc|otp|confirmation(?:[ /]+code)?|пароль|секрет|токен|пин|(?:код[ /]*)?подтвержден\p{L}*)(?:(?: *\/+ *)\S+| +(?=\S*(?:\d|[/~]))\S+)/iu;
const completeCardLikeText = /\d(?:[ /]*\d){12,18}/u;

function normalizeSafeText(value: string): string {
  return value.normalize('NFKC').replace(SAFE_SCAN_ZERO_WIDTH, '');
}

export function normalizeSafeScanText(value: string): string {
  return normalizeSafeText(value)
    .replace(SAFE_SCAN_SEPARATORS, '/')
    .replace(/\s+/gu, ' ');
}

function containsCredentialLikeText(value: string): boolean {
  return secretLikeText.test(normalizeSafeScanText(value));
}

export function containsSecretLikeText(value: string): boolean {
  const scanned = normalizeSafeScanText(value);
  return secretLikeText.test(scanned) || completeCardLikeText.test(scanned);
}

const safeFreeText = (schema: z.ZodString) => schema.refine(
  (value) => !containsSecretLikeText(value),
  'Секретные данные и реквизиты карт хранить нельзя.',
);

function passesLuhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function containsContactSecret(kind: ContactMethodKind, value: string): boolean {
  if (containsCredentialLikeText(value)) return true;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits) || !passesLuhn(digits)) return false;
  return !((kind === 'phone' || kind === 'whatsapp') && /^\+[\d\s().-]+$/.test(value.trim()) && digits.length <= 15);
}

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
    size: z.number({ error: 'Размер файла должен быть числом.' }).int('Размер файла должен быть целым числом.').positive('Файл не может быть пустым.').max(MAX_ATTACHMENT_BYTES, 'Размер файла не должен превышать 25 МиБ.'),
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

export function mergeKnowledgePatch(
  current: z.input<typeof knowledgeInputSchema>,
  input: z.input<typeof knowledgePatchSchema>,
): z.output<typeof knowledgeInputSchema> {
  const patch = knowledgePatchSchema.parse(input);
  const targetKind = patch.kind ?? current.kind;
  if (patch.linkUrl != null && targetKind !== 'link') {
    throw new z.ZodError([{
      code: 'custom',
      message: 'Адрес ссылки доступен только для материала типа «Ссылка».',
      path: ['linkUrl'],
    }]);
  }
  return knowledgeInputSchema.parse({ ...current, ...patch });
}

export const contactMethodSchema = z
  .object({
    kind: z.enum(['phone', 'telegram', 'whatsapp'] satisfies [ContactMethodKind, ...ContactMethodKind[]], { error: 'Выберите способ связи.' }),
    value: z.string({ error: 'Контакт должен быть текстом.' }).trim().min(1, 'Введите контакт.').max(300, 'Контакт слишком длинный.'),
  }, { error: 'Способ связи должен быть объектом.' })
  .strict()
  .transform((method, context) => {
    if (containsContactSecret(method.kind, method.value)) {
      context.addIssue({ code: 'custom', message: 'Секретные данные и реквизиты карт хранить нельзя.', path: ['value'] });
      return z.NEVER;
    }
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

const BUILTIN_BITWARDEN_ORIGINS = ['https://vault.bitwarden.com', 'https://vault.bitwarden.eu'] as const;
const secretQueryKey = /(?:token|signature|credential|secret|password|passphrase|pin|cvv|cvc|otp|confirmation|x-amz-)/iu;

function allowedBitwardenOrigins(selfHostedOrigins: readonly string[]): Set<string> {
  const origins = new Set<string>(BUILTIN_BITWARDEN_ORIGINS);
  for (const value of selfHostedOrigins) {
    try {
      const url = new URL(value);
      if (
        url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        url.pathname === '/' && !url.search && !url.hash && url.origin === value.replace(/\/$/, '')
      ) origins.add(url.origin);
    } catch {
      // Invalid configuration entries never broaden the allowlist.
    }
  }
  return origins;
}

function decodeUrlComponent(value: string): string | null {
  let decoded = value;
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
    return null;
  } catch {
    return null;
  }
}

function containsUrlSecret(value: string): boolean {
  const withoutLegitimateUuid = normalizeSafeText(value).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu,
    '',
  );
  return containsSecretLikeText(withoutLegitimateUuid);
}

export function isAllowedBitwardenUrl(value: string, selfHostedOrigins: readonly string[] = []): boolean {
  const origins = allowedBitwardenOrigins(selfHostedOrigins);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !origins.has(url.origin)) return false;
    const pathname = decodeUrlComponent(url.pathname);
    const fragment = decodeUrlComponent(url.hash.slice(1));
    if (pathname === null || fragment === null || containsUrlSecret(pathname) || containsUrlSecret(fragment)) return false;
    return [...url.searchParams.entries()].every(([key, queryValue]) => {
      const decodedKey = decodeUrlComponent(key);
      const decodedValue = decodeUrlComponent(queryValue);
      return decodedKey !== null && decodedValue !== null
        && !secretQueryKey.test(normalizeSafeText(decodedKey))
        && !containsUrlSecret(decodedKey)
        && !containsUrlSecret(decodedValue);
    });
  } catch {
    return false;
  }
}

const secureText = (label: string, maximum = 2_000) => safeFreeText(
  z.string({ error: `${label} должно быть текстом.` }).trim().min(1, `Заполните поле «${label}».`).max(maximum, `${label} слишком длинное.`),
);
const optionalSecureText = (label: string, maximum = 280) => safeFreeText(
  z.string({ error: `${label} должно быть текстом.` }).trim().min(1, `Заполните поле «${label}».`).max(maximum, `${label} слишком длинное.`),
).nullable().optional();
const reviewDateSchema = z.string({ error: 'Дата проверки должна быть строкой.' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Укажите дату проверки в формате ГГГГ-ММ-ДД.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Укажите существующую дату проверки.')
  .nullable()
  .optional();
const lastFourSchema = z.string({ error: 'Последние четыре цифры должны быть строкой.' })
  .regex(/^\d{4}$/, 'Укажите ровно четыре последние цифры.')
  .nullable()
  .optional();

function secureItemShape(selfHostedOrigins: readonly string[]) {
  return {
    title: safeFreeText(z.string({ error: 'Название безопасной записи должно быть текстом.' })
      .trim().min(1, 'Введите название безопасной записи.').max(280, 'Название безопасной записи слишком длинное.')),
    purpose: secureText('Назначение', 2_000),
    owner: secureText('Ответственный', 280),
    reviewDate: reviewDateSchema,
    cardBank: optionalSecureText('Банк'),
    cardHolder: optionalSecureText('Держатель карты'),
    cardPurpose: optionalSecureText('Назначение карты', 2_000),
    lastFour: lastFourSchema,
    externalUrl: z.string({ error: 'Укажите корректную HTTPS-ссылку Bitwarden.' })
      .trim()
      .min(1, 'Укажите корректную HTTPS-ссылку Bitwarden.')
      .max(2_000, 'Ссылка Bitwarden слишком длинная.')
      .refine((value) => isAllowedBitwardenUrl(value, selfHostedOrigins), 'Укажите корректную HTTPS-ссылку Bitwarden.'),
  } as const;
}

export function createSecureItemInputSchema(selfHostedOrigins: readonly string[]) {
  return z.object(secureItemShape(selfHostedOrigins), { error: 'Безопасная запись должна быть объектом.' })
    .strict()
    .transform((item) => ({
      ...item,
      reviewDate: item.reviewDate ?? null,
      cardBank: item.cardBank ?? null,
      cardHolder: item.cardHolder ?? null,
      cardPurpose: item.cardPurpose ?? null,
      lastFour: item.lastFour ?? null,
    }));
}

export function createSecureItemPatchSchema(selfHostedOrigins: readonly string[]) {
  const shape = secureItemShape(selfHostedOrigins);
  return z.object({
    title: shape.title.optional(),
    purpose: shape.purpose.optional(),
    owner: shape.owner.optional(),
    reviewDate: shape.reviewDate,
    cardBank: shape.cardBank,
    cardHolder: shape.cardHolder,
    cardPurpose: shape.cardPurpose,
    lastFour: shape.lastFour,
    externalUrl: shape.externalUrl.optional(),
  }, { error: 'Изменения безопасной записи должны быть объектом.' }).strict();
}

export const secureItemInputSchema = createSecureItemInputSchema([]);
export const secureItemPatchSchema = createSecureItemPatchSchema([]);

export type TaskInput = z.input<typeof taskInputSchema>;
export type TaskPatchInput = z.input<typeof taskPatchSchema>;
export type CommentInput = z.input<typeof commentInputSchema>;
export type KnowledgeInput = z.input<typeof knowledgeInputSchema>;
export type KnowledgePatchInput = z.input<typeof knowledgePatchSchema>;
export type ContactInput = z.input<typeof contactInputSchema>;
export type ContactPatchInput = z.input<typeof contactPatchSchema>;
export type SecureItemInput = z.input<typeof secureItemInputSchema>;
export type SecureItemPatchInput = z.input<typeof secureItemPatchSchema>;
export type ParsedTaskInput = z.output<typeof taskInputSchema>;
export type ParsedTaskPatchInput = z.output<typeof taskPatchSchema>;
export type ParsedCommentInput = z.output<typeof commentInputSchema>;
export type ParsedKnowledgeInput = z.output<typeof knowledgeInputSchema>;
export type ParsedKnowledgePatchInput = z.output<typeof knowledgePatchSchema>;
export type ParsedContactInput = z.output<typeof contactInputSchema>;
export type ParsedContactPatchInput = z.output<typeof contactPatchSchema>;
export type ParsedSecureItemInput = z.output<typeof secureItemInputSchema>;
export type ParsedSecureItemPatchInput = z.output<typeof secureItemPatchSchema>;

export const DEFAULT_PRIORITY: Priority = 3;
