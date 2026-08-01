import { z } from 'zod';

import type { ContactCategory, ContactMethodKind, KnowledgeKind, Priority } from '@/domain/types';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const prioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const optionalTextSchema = z.string().trim().max(10_000).optional();
const nullableIdSchema = z.string().trim().min(1).max(200).nullable().optional();

export const attachmentInputSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(200),
    size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
    storagePath: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const taskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(280),
    description: z.string().trim().max(20_000).default(''),
    priority: prioritySchema.default(3),
    statusId: z.string().trim().min(1).max(200).optional(),
    sectionId: nullableIdSchema.default(null),
    assigneeId: nullableIdSchema.default(null),
    dueAt: z.string().datetime({ offset: true }).nullable().optional().default(null),
    attachments: z.array(attachmentInputSchema).max(20).default([]),
  })
  .strict();

export const commentInputSchema = z
  .object({
    taskId: z.string().trim().min(1).max(200),
    authorId: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const knowledgeInputSchema = z
  .object({
    title: z.string().trim().min(1).max(280),
    body: z.string().trim().max(30_000).default(''),
    kind: z.enum(['note', 'instruction', 'document', 'link'] satisfies [KnowledgeKind, ...KnowledgeKind[]]),
    sectionId: nullableIdSchema.default(null),
    attachments: z.array(attachmentInputSchema).max(20).default([]),
  })
  .strict();

export const contactMethodSchema = z
  .object({
    kind: z.enum(['phone', 'telegram', 'whatsapp'] satisfies [ContactMethodKind, ...ContactMethodKind[]]),
    value: z.string().trim().min(1).max(300),
  })
  .strict();

export const contactInputSchema = z
  .object({
    name: z.string().trim().min(1).max(280),
    category: z.enum(['supplier', 'contractor', 'partner', 'other'] satisfies [
      ContactCategory,
      ...ContactCategory[],
    ]).default('other'),
    notes: optionalTextSchema.default(''),
    methods: z.array(contactMethodSchema).min(1).max(10),
  })
  .strict();

const safeMetadataValueSchema = z.union([
  z.string({ error: 'Значение метаданных должно быть строкой, числом, логическим значением или пустым.' }).max(2_000, 'Значение метаданных слишком длинное.'),
  z.number({ error: 'Значение метаданных должно быть строкой, числом, логическим значением или пустым.' }).finite('Число в метаданных должно быть конечным.'),
  z.boolean({ error: 'Значение метаданных должно быть строкой, числом, логическим значением или пустым.' }),
  z.null(),
]);

const sensitiveMetadataKey = /(?:password|пароль|passphrase|secret|секрет|token|токен|pin|пин|cvv|cvc|otp|(?:код\s*)?подтвержден\p{L}*|confirmation\s*(?:code)?|card(?:number)?|pan)/iu;

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
  .record(z.string().trim().min(1, 'Название поля метаданных не может быть пустым.').max(100, 'Название поля метаданных слишком длинное.'), safeMetadataValueSchema)
  .superRefine((metadata, context) => {
    for (const [key, value] of Object.entries(metadata)) {
      if (sensitiveMetadataKey.test(key)) {
        context.addIssue({ code: 'custom', message: 'Секретные данные и реквизиты карт хранить нельзя.', path: [key] });
      }
      if ((typeof value === 'string' || typeof value === 'number') && containsPanLikeSequence(value)) {
        context.addIssue({ code: 'custom', message: 'Полный номер карты хранить нельзя.', path: [key] });
      }
    }
  });

export const secureItemInputSchema = z
  .object({
    title: z.string().trim().min(1).max(280),
    externalUrl: z
      .string({ error: 'Укажите корректную HTTPS-ссылку Bitwarden.' })
      .trim()
      .min(1, 'Укажите корректную HTTPS-ссылку Bitwarden.')
      .refine(isBitwardenUrl, 'Укажите корректную HTTPS-ссылку Bitwarden.'),
    metadata: safeMetadataSchema.default({}),
  })
  .strict();

export type TaskInput = z.input<typeof taskInputSchema>;
export type CommentInput = z.input<typeof commentInputSchema>;
export type KnowledgeInput = z.input<typeof knowledgeInputSchema>;
export type ContactInput = z.input<typeof contactInputSchema>;
export type SecureItemInput = z.input<typeof secureItemInputSchema>;
export type ParsedTaskInput = z.output<typeof taskInputSchema>;
export type ParsedCommentInput = z.output<typeof commentInputSchema>;
export type ParsedKnowledgeInput = z.output<typeof knowledgeInputSchema>;
export type ParsedContactInput = z.output<typeof contactInputSchema>;
export type ParsedSecureItemInput = z.output<typeof secureItemInputSchema>;

export const DEFAULT_PRIORITY: Priority = 3;
