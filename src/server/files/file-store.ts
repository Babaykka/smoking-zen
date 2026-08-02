import { randomUUID } from 'node:crypto';

import type { ValidatedUploadPreflight } from '@/domain/files';
import { FileValidationError } from '@/domain/files';
import type { Attachment } from '@/domain/types';
import { createRandomObjectKey, validateFile } from '@/server/files/validate-file';

export const SIGNED_UPLOAD_QUARANTINE_SECONDS = 2 * 60 * 60 + 5 * 60;
export const SIGNED_DOWNLOAD_SECONDS = 60;

export type AttachmentParent = { type: 'task' | 'knowledge'; id: string };

export type StoredAttachment = {
  id: string;
  workspaceId: string;
  taskId: string | null;
  knowledgeItemId: string | null;
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
  state: 'quarantine' | 'ready';
  sha256: string | null;
  quarantineExpiresAt: string | null;
  completedAt: string | null;
};

export type NewQuarantineAttachment = StoredAttachment & { createdBy: string };

export type ReadyAttachmentMutation = {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  storagePath: string;
};

export type QueuedObject = { id: string; workspaceId: string; storagePath: string };
export type QuarantineRetirementReason = 'expired' | 'parent_missing' | 'invalid_content';

export interface FileBackend {
  parentExists(workspaceId: string, parent: AttachmentParent): Promise<boolean>;
  insertQuarantine(record: NewQuarantineAttachment): Promise<void>;
  deleteQuarantine(workspaceId: string, attachmentId: string, storagePath: string): Promise<void>;
  retireQuarantine(
    workspaceId: string,
    attachmentId: string,
    storagePath: string,
    reason: QuarantineRetirementReason,
  ): Promise<boolean>;
  createSignedUploadUrl(storagePath: string): Promise<string>;
  getAttachment(workspaceId: string, attachmentId: string): Promise<StoredAttachment | null>;
  downloadObject(storagePath: string): Promise<Uint8Array>;
  uploadReadyObject(storagePath: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  completeUpload(record: StoredAttachment, ready: ReadyAttachmentMutation): Promise<StoredAttachment>;
  queueObjectCleanup(workspaceId: string, storagePath: string, attachmentId: string): Promise<boolean>;
  listExpiredQuarantines(now: string, limit: number): Promise<StoredAttachment[]>;
  listQueuedObjects(now: string, limit: number): Promise<QueuedObject[]>;
  prepareQueuedObjectRemoval(id: string): Promise<string | null>;
  finishQueuedObjectRemoval(id: string, leaseId: string): Promise<boolean>;
  removeObject(storagePath: string): Promise<void>;
  createSignedDownloadUrl(storagePath: string, expiresIn: number, downloadName: string): Promise<string>;
}

export class FileNotFoundError extends Error {
  constructor() {
    super('Файл не найден.');
    this.name = 'FileNotFoundError';
  }
}

export class ParentNotFoundError extends Error {
  constructor() {
    super('Запись для вложения не найдена.');
    this.name = 'ParentNotFoundError';
  }
}

export class FileNotReadyError extends Error {
  constructor() {
    super('Файл ещё не прошёл безопасную проверку.');
    this.name = 'FileNotReadyError';
  }
}

export class UploadExpiredError extends Error {
  constructor() {
    super('Время загрузки истекло. Начните загрузку заново.');
    this.name = 'UploadExpiredError';
  }
}

export class FileOperationError extends Error {
  constructor(message = 'Не удалось выполнить операцию с файлом.') {
    super(message);
    this.name = 'FileOperationError';
  }
}

export type SignedUpload = Attachment & {
  uploadUrl: string;
  expiresAt: string;
};

export type SignedDownload = Attachment & {
  url: string;
  expiresIn: number;
};

export interface PrivateFileStore {
  signUpload(
    workspaceId: string,
    actorUserId: string,
    input: { parent: AttachmentParent; file: ValidatedUploadPreflight },
  ): Promise<SignedUpload>;
  completeUpload(workspaceId: string, attachmentId: string): Promise<Attachment>;
  signDownload(workspaceId: string, attachmentId: string, expiresIn: number): Promise<SignedDownload>;
  cleanupExpiredUploads(now?: Date, limit?: number): Promise<{ removed: number; failed: number }>;
}

type FileStoreOptions = {
  clock?: () => Date;
  idFactory?: () => string;
};

function publicAttachment(record: Pick<StoredAttachment, 'id' | 'name' | 'mimeType' | 'size'>): Attachment {
  return { id: record.id, name: record.name, mimeType: record.mimeType, size: record.size };
}

function parentForAttachment(record: StoredAttachment): AttachmentParent | null {
  if (record.taskId && !record.knowledgeItemId) return { type: 'task', id: record.taskId };
  if (record.knowledgeItemId && !record.taskId) return { type: 'knowledge', id: record.knowledgeItemId };
  return null;
}

async function bestEffortRetire(
  backend: FileBackend,
  record: StoredAttachment,
  reason: Exclude<QuarantineRetirementReason, 'expired'>,
): Promise<void> {
  try {
    await backend.retireQuarantine(record.workspaceId, record.id, record.storagePath, reason);
  } catch {
    // Preserve the original safe error. The quarantine row and signed path remain
    // durable for a later database-authorized retirement attempt.
  }
}

export function createPrivateFileStore(backend: FileBackend, options: FileStoreOptions = {}): PrivateFileStore {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return {
    async signUpload(workspaceId, actorUserId, input) {
      if (!await backend.parentExists(workspaceId, input.parent)) throw new ParentNotFoundError();

      const id = idFactory();
      const storagePath = createRandomObjectKey(workspaceId, 'quarantine', idFactory);
      const now = clock();
      const expiresAt = new Date(now.getTime() + SIGNED_UPLOAD_QUARANTINE_SECONDS * 1_000).toISOString();
      const record: NewQuarantineAttachment = {
        id,
        workspaceId,
        taskId: input.parent.type === 'task' ? input.parent.id : null,
        knowledgeItemId: input.parent.type === 'knowledge' ? input.parent.id : null,
        name: input.file.name,
        mimeType: input.file.declaredMime,
        size: input.file.size,
        storagePath,
        state: 'quarantine',
        sha256: null,
        quarantineExpiresAt: expiresAt,
        completedAt: null,
        createdBy: actorUserId,
      };

      try {
        await backend.insertQuarantine(record);
      } catch {
        throw new FileOperationError('Не удалось подготовить загрузку файла.');
      }

      let uploadUrl: string;
      try {
        uploadUrl = await backend.createSignedUploadUrl(storagePath);
      } catch {
        try {
          await backend.deleteQuarantine(workspaceId, id, storagePath);
        } catch {
          // No signed URL escaped. If hard deletion fails, metadata remains durable
          // and the ordinary expiry sweep can retire it later.
        }
        throw new FileOperationError('Не удалось подготовить загрузку файла.');
      }

      return { ...publicAttachment(record), uploadUrl, expiresAt };
    },

    async completeUpload(workspaceId, attachmentId) {
      const record = await backend.getAttachment(workspaceId, attachmentId);
      if (!record) throw new FileNotFoundError();
      if (record.state === 'quarantine') {
        let expired: boolean;
        try {
          expired = await backend.retireQuarantine(
            workspaceId, record.id, record.storagePath, 'expired',
          );
        } catch {
          throw new FileOperationError('Не удалось проверить срок загрузки файла.');
        }
        if (expired) throw new UploadExpiredError();
      }
      const parent = parentForAttachment(record);
      if (!parent || !await backend.parentExists(workspaceId, parent)) {
        if (record.state === 'quarantine') await bestEffortRetire(backend, record, 'parent_missing');
        throw new ParentNotFoundError();
      }
      if (record.state === 'ready') return publicAttachment(record);
      if (!record.quarantineExpiresAt) throw new FileOperationError('Не удалось завершить загрузку файла.');

      let uploadedBytes: Uint8Array;
      try {
        uploadedBytes = await backend.downloadObject(record.storagePath);
      } catch {
        throw new FileOperationError('Не удалось получить загруженный файл для проверки.');
      }

      let validated;
      try {
        validated = await validateFile({
          name: record.name,
          declaredMime: record.mimeType,
          declaredSize: record.size,
          bytes: uploadedBytes,
        });
      } catch (error) {
        if (error instanceof FileValidationError) {
          await bestEffortRetire(backend, record, 'invalid_content');
          throw error;
        }
        throw new FileOperationError('Не удалось проверить загруженный файл.');
      }

      // The ready object name is deterministic and opaque. It can be rediscovered after an
      // ambiguous provider response without exposing workspace or lifecycle semantics.
      const readyPath = record.id;
      // Establish durable, delayed cleanup before attempting the external write. If the
      // provider commits and its response is lost, the object is still reconciliable.
      let cleanupArmed: boolean;
      try {
        cleanupArmed = await backend.queueObjectCleanup(workspaceId, readyPath, record.id);
      } catch {
        throw new FileOperationError('Не удалось сохранить проверенный файл.');
      }
      if (!cleanupArmed) {
        try {
          if (await backend.retireQuarantine(workspaceId, record.id, record.storagePath, 'expired')) {
            throw new UploadExpiredError();
          }
        } catch (error) {
          if (error instanceof UploadExpiredError) throw error;
        }
        throw new FileOperationError('Не удалось сохранить проверенный файл.');
      }

      try {
        await backend.uploadReadyObject(readyPath, validated.bytes, validated.mimeType);
      } catch {
        try {
          const existing = await backend.downloadObject(readyPath);
          if (!Buffer.from(existing).equals(validated.bytes)) {
            throw new Error('ready object differs');
          }
        } catch {
          throw new FileOperationError('Не удалось сохранить проверенный файл.');
        }
      }

      try {
        const completed = await backend.completeUpload(record, {
          name: validated.name,
          mimeType: validated.mimeType,
          size: validated.size,
          sha256: validated.sha256,
          storagePath: readyPath,
        });
        return publicAttachment(completed);
      } catch {
        try {
          const reconciled = await backend.getAttachment(workspaceId, attachmentId);
          if (
            reconciled?.state === 'ready'
            && reconciled.storagePath === readyPath
            && reconciled.sha256 === validated.sha256
            && reconciled.completedAt
          ) return publicAttachment(reconciled);
        } catch {
          // The pre-established cleanup row remains authoritative and reference-safe.
        }
        try {
          if (await backend.retireQuarantine(workspaceId, record.id, record.storagePath, 'expired')) {
            throw new UploadExpiredError();
          }
        } catch (error) {
          if (error instanceof UploadExpiredError) throw error;
        }
        throw new FileOperationError('Не удалось завершить загрузку файла.');
      }
    },

    async signDownload(workspaceId, attachmentId, expiresIn) {
      if (expiresIn !== SIGNED_DOWNLOAD_SECONDS) throw new FileOperationError('Недопустимый срок ссылки на файл.');
      const record = await backend.getAttachment(workspaceId, attachmentId);
      if (!record) throw new FileNotFoundError();
      const parent = parentForAttachment(record);
      if (!parent || !await backend.parentExists(workspaceId, parent)) throw new FileNotFoundError();
      if (record.state !== 'ready' || !record.sha256 || !record.completedAt) throw new FileNotReadyError();
      let url: string;
      try {
        url = await backend.createSignedDownloadUrl(record.storagePath, expiresIn, record.name);
      } catch {
        throw new FileOperationError('Не удалось подготовить скачивание файла.');
      }
      return { ...publicAttachment(record), url, expiresIn };
    },

    async cleanupExpiredUploads(now = clock(), limit = 100) {
      const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const expired = await backend.listExpiredQuarantines(now.toISOString(), boundedLimit);
      let removed = 0;
      let failed = 0;

      for (const record of expired) {
        try {
          if (await backend.retireQuarantine(
            record.workspaceId, record.id, record.storagePath, 'expired',
          )) removed += 1;
        } catch {
          failed += 1;
        }
      }

      // Retirement atomically queues its object only after the database clock
      // proves expiry. Read the queue afterwards so the same sweep can remove it.
      const queued = await backend.listQueuedObjects(now.toISOString(), boundedLimit);
      for (const object of queued) {
        try {
          const leaseId = await backend.prepareQueuedObjectRemoval(object.id);
          if (!leaseId) continue;
          await backend.removeObject(object.storagePath);
          await backend.finishQueuedObjectRemoval(object.id, leaseId);
          removed += 1;
        } catch {
          failed += 1;
        }
      }
      return { removed, failed };
    },
  };
}
