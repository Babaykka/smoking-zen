import { randomUUID } from 'node:crypto';

import type { ValidatedUploadPreflight } from '@/domain/files';
import { FileValidationError } from '@/domain/files';
import type { Attachment, TrashItem } from '@/domain/types';
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
  version: number;
  deletedAt: string | null;
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
  reserveQuarantine(record: NewQuarantineAttachment): Promise<StoredAttachment>;
  cancelReservation(workspaceId: string, attachmentId: string, storagePath: string): Promise<boolean>;
  retireQuarantine(
    workspaceId: string,
    attachmentId: string,
    storagePath: string,
    reason: QuarantineRetirementReason,
    validationLeaseId?: string,
  ): Promise<boolean>;
  claimValidation(workspaceId: string, attachmentId: string, storagePath: string): Promise<string | null>;
  releaseValidation(workspaceId: string, attachmentId: string, storagePath: string, validationLeaseId: string): Promise<boolean>;
  createSignedUploadUrl(storagePath: string): Promise<string>;
  getAttachment(workspaceId: string, attachmentId: string): Promise<StoredAttachment | null>;
  downloadObject(storagePath: string): Promise<Uint8Array>;
  uploadReadyObject(storagePath: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  completeUpload(record: StoredAttachment, ready: ReadyAttachmentMutation, validationLeaseId: string): Promise<StoredAttachment>;
  queueObjectCleanup(workspaceId: string, storagePath: string, attachmentId: string): Promise<boolean>;
  listExpiredQuarantines(now: string, limit: number): Promise<StoredAttachment[]>;
  listQueuedObjects(now: string, limit: number): Promise<QueuedObject[]>;
  prepareQueuedObjectRemoval(id: string): Promise<string | null>;
  finishQueuedObjectRemoval(id: string, leaseId: string): Promise<boolean>;
  removeObject(storagePath: string): Promise<void>;
  createSignedDownloadUrl(storagePath: string, expiresIn: number, downloadName: string): Promise<string>;
  setAttachmentDeleted(workspaceId: string, attachmentId: string, expectedVersion: number, restore: boolean): Promise<StoredAttachment>;
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

export class UploadQuotaExceededError extends Error {
  constructor() {
    super('Лимит новых загрузок исчерпан. Повторите попытку позже.');
    this.name = 'UploadQuotaExceededError';
  }
}

export class UploadValidationBusyError extends Error {
  constructor() {
    super('Файл уже проходит проверку. Повторите попытку позже.');
    this.name = 'UploadValidationBusyError';
  }
}

export class FileOperationError extends Error {
  constructor(message = 'Не удалось выполнить операцию с файлом.') {
    super(message);
    this.name = 'FileOperationError';
  }
}

export type FileMutationErrorCode = 'version_conflict' | 'restore_expired' | 'restore_not_deleted' | 'file_not_found' | 'parent_not_found' | 'file_not_ready';

export class FileMutationError extends Error {
  constructor(
    readonly code: FileMutationErrorCode,
    readonly expectedVersion?: number,
    readonly actualVersion?: number,
  ) {
    super(code);
    this.name = 'FileMutationError';
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
  archiveAttachment(workspaceId: string, attachmentId: string, expectedVersion: number): Promise<TrashItem>;
  restoreAttachment(workspaceId: string, attachmentId: string, expectedVersion: number): Promise<Attachment>;
  cleanupExpiredUploads(now?: Date, limit?: number): Promise<{ removed: number; failed: number }>;
}

type FileStoreOptions = {
  clock?: () => Date;
  idFactory?: () => string;
};

function publicAttachment(record: Pick<StoredAttachment, 'id' | 'name' | 'mimeType' | 'size' | 'version'>): Attachment {
  return { id: record.id, name: record.name, mimeType: record.mimeType, size: record.size, version: record.version };
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
  validationLeaseId: string,
): Promise<boolean> {
  try {
    return await backend.retireQuarantine(
      record.workspaceId, record.id, record.storagePath, reason, validationLeaseId,
    );
  } catch {
    // Preserve the original safe error. The quarantine row and signed path remain
    // durable for a later database-authorized retirement attempt.
    return false;
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
        version: 1,
        deletedAt: null,
        createdBy: actorUserId,
      };

      let reserved: StoredAttachment;
      try {
        reserved = await backend.reserveQuarantine(record);
      } catch (error) {
        if (error instanceof UploadQuotaExceededError || error instanceof ParentNotFoundError) throw error;
        throw new FileOperationError('Не удалось подготовить загрузку файла.');
      }

      let uploadUrl: string;
      try {
        uploadUrl = await backend.createSignedUploadUrl(reserved.storagePath);
      } catch {
        try {
          await backend.cancelReservation(workspaceId, reserved.id, reserved.storagePath);
        } catch {
          // No signed URL escaped. If cancellation fails, the durable reservation
          // still expires normally and continues to count against rolling limits.
        }
        throw new FileOperationError('Не удалось подготовить загрузку файла.');
      }

      if (!reserved.quarantineExpiresAt) throw new FileOperationError('Не удалось подготовить загрузку файла.');
      return { ...publicAttachment(reserved), uploadUrl, expiresAt: reserved.quarantineExpiresAt };
    },

    async completeUpload(workspaceId, attachmentId) {
      const record = await backend.getAttachment(workspaceId, attachmentId);
      if (!record) throw new FileNotFoundError();
      const parent = parentForAttachment(record);
      if (record.state === 'ready') {
        if (!parent || !await backend.parentExists(workspaceId, parent)) throw new ParentNotFoundError();
        return publicAttachment(record);
      }

      let expired: boolean;
      try {
        expired = await backend.retireQuarantine(
          workspaceId, record.id, record.storagePath, 'expired',
        );
      } catch {
        throw new FileOperationError('Не удалось проверить срок загрузки файла.');
      }
      if (expired) throw new UploadExpiredError();
      if (!record.quarantineExpiresAt) throw new FileOperationError('Не удалось завершить загрузку файла.');

      let validationLeaseId: string | null;
      try {
        validationLeaseId = await backend.claimValidation(workspaceId, record.id, record.storagePath);
      } catch (error) {
        if (error instanceof UploadExpiredError || error instanceof ParentNotFoundError || error instanceof FileNotFoundError) {
          throw error;
        }
        throw new FileOperationError('Не удалось начать проверку файла.');
      }
      if (!validationLeaseId) throw new UploadValidationBusyError();

      let lifecycleFinalized = false;
      try {
        if (!parent || !await backend.parentExists(workspaceId, parent)) {
          lifecycleFinalized = await bestEffortRetire(
            backend, record, 'parent_missing', validationLeaseId,
          );
          throw new ParentNotFoundError();
        }

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
            lifecycleFinalized = await bestEffortRetire(
              backend, record, 'invalid_content', validationLeaseId,
            );
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
          }, validationLeaseId);
          lifecycleFinalized = true;
          return publicAttachment(completed);
        } catch {
          try {
            const reconciled = await backend.getAttachment(workspaceId, attachmentId);
            if (
              reconciled?.state === 'ready'
              && reconciled.storagePath === readyPath
              && reconciled.sha256 === validated.sha256
              && reconciled.completedAt
            ) {
              lifecycleFinalized = true;
              return publicAttachment(reconciled);
            }
          } catch {
            // The pre-established cleanup row remains authoritative and reference-safe.
          }
          try {
            if (await backend.retireQuarantine(workspaceId, record.id, record.storagePath, 'expired')) {
              lifecycleFinalized = true;
              throw new UploadExpiredError();
            }
          } catch (error) {
            if (error instanceof UploadExpiredError) throw error;
          }
          throw new FileOperationError('Не удалось завершить загрузку файла.');
        }
      } finally {
        if (!lifecycleFinalized) {
          try {
            await backend.releaseValidation(
              workspaceId, record.id, record.storagePath, validationLeaseId,
            );
          } catch {
            // The database lease expires and can be reclaimed without process-local state.
          }
        }
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

    async archiveAttachment(workspaceId, attachmentId, expectedVersion) {
      const record = await backend.setAttachmentDeleted(workspaceId, attachmentId, expectedVersion, false);
      const parent = parentForAttachment(record);
      if (!parent || record.state !== 'ready' || !record.deletedAt) {
        throw new FileOperationError('Не удалось переместить файл в корзину.');
      }
      return {
        entity: 'attachment', id: record.id, title: record.name, version: record.version,
        deletedAt: record.deletedAt, attachment: publicAttachment(record), parentType: parent.type, parentId: parent.id,
      };
    },

    async restoreAttachment(workspaceId, attachmentId, expectedVersion) {
      const record = await backend.setAttachmentDeleted(workspaceId, attachmentId, expectedVersion, true);
      if (record.state !== 'ready' || record.deletedAt !== null) {
        throw new FileOperationError('Не удалось восстановить файл.');
      }
      return publicAttachment(record);
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
