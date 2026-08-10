import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  AttachmentParent,
  FileBackend,
  NewQuarantineAttachment,
  QueuedObject,
  ReadyAttachmentMutation,
  StoredAttachment,
} from '@/server/files/file-store';
import {
  FileMutationError,
  FileNotFoundError,
  ParentNotFoundError,
  UploadExpiredError,
  UploadQuotaExceededError,
} from '@/server/files/file-store';

const FILE_BUCKET = 'workspace-files';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ResultError = { message?: string; status?: number | string; statusCode?: number | string };
type Result = { data: unknown; error: ResultError | null };

function dataOrThrow(result: Result): unknown {
  if (result.error) throw new Error('Private file backend operation failed.');
  return result.data;
}

function isMissingStorageObject(error: ResultError | null): boolean {
  return error !== null && Number(error.statusCode ?? error.status) === 404;
}

function storedAttachment(value: unknown): StoredAttachment {
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    knowledgeItemId: row.knowledge_item_id === null ? null : String(row.knowledge_item_id),
    name: String(row.name),
    mimeType: String(row.mime_type),
    size: Number(row.size_bytes),
    storagePath: String(row.storage_path),
    state: row.state === 'ready' ? 'ready' : 'quarantine',
    sha256: row.sha256 === null ? null : String(row.sha256),
    quarantineExpiresAt: row.quarantine_expires_at === null ? null : String(row.quarantine_expires_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    version: Number(row.version),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

const ATTACHMENT_COLUMNS = [
  'id', 'workspace_id', 'task_id', 'knowledge_item_id', 'name', 'mime_type', 'size_bytes',
  'storage_path', 'state', 'sha256', 'quarantine_expires_at', 'completed_at', 'version', 'deleted_at',
].join(',');

export function createSupabaseFileBackend(client: SupabaseClient): FileBackend {
  const bucket = client.storage.from(FILE_BUCKET);

  return {
    async parentExists(workspaceId: string, parent: AttachmentParent) {
      const table = parent.type === 'task' ? 'tasks' : 'knowledge_items';
      const result = await client.from(table).select('id').eq('workspace_id', workspaceId).eq('id', parent.id)
        .is('deleted_at', null).maybeSingle() as Result;
      return dataOrThrow(result) !== null;
    },

    async reserveQuarantine(record: NewQuarantineAttachment) {
      const result = await client.rpc('reserve_attachment_upload', {
        p_workspace_id: record.workspaceId,
        p_attachment_id: record.id,
        p_task_id: record.taskId,
        p_knowledge_item_id: record.knowledgeItemId,
        p_created_by: record.createdBy,
        p_name: record.name,
        p_mime_type: record.mimeType,
        p_size_bytes: record.size,
        p_storage_path: record.storagePath,
      }) as Result;
      if (result.error) {
        const message = String(result.error.message ?? '');
        if (/upload_(?:workspace|member)(?:_byte)?_quota_exceeded/u.test(message)) {
          throw new UploadQuotaExceededError();
        }
        if (message.includes('upload_parent_not_found') || message.includes('upload_member_not_found')) {
          throw new ParentNotFoundError();
        }
        throw new Error('Private file backend operation failed.');
      }
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row) throw new Error('Upload reservation was not returned.');
      return storedAttachment(row);
    },

    async cancelReservation(workspaceId, attachmentId, storagePath) {
      const result = await client.rpc('cancel_attachment_upload_reservation', {
        p_workspace_id: workspaceId,
        p_attachment_id: attachmentId,
        p_expected_storage_path: storagePath,
      }) as Result;
      const cancelled = dataOrThrow(result);
      if (typeof cancelled !== 'boolean') throw new Error('Upload reservation cancellation verdict was not returned.');
      return cancelled;
    },

    async retireQuarantine(workspaceId, attachmentId, storagePath, reason, validationLeaseId) {
      const result = await client.rpc('retire_quarantine_attachment', {
        p_workspace_id: workspaceId,
        p_attachment_id: attachmentId,
        p_expected_storage_path: storagePath,
        p_reason: reason,
        ...(validationLeaseId ? { p_validation_lease_id: validationLeaseId } : {}),
      }) as Result;
      const retired = dataOrThrow(result);
      if (typeof retired !== 'boolean') throw new Error('Quarantine retirement verdict was not returned.');
      return retired;
    },

    async claimValidation(workspaceId, attachmentId, storagePath) {
      const result = await client.rpc('claim_attachment_validation', {
        p_workspace_id: workspaceId,
        p_attachment_id: attachmentId,
        p_expected_storage_path: storagePath,
      }) as Result;
      if (result.error) {
        const message = String(result.error.message ?? '');
        if (message.includes('attachment_validation_expired')) throw new UploadExpiredError();
        if (message.includes('attachment_validation_parent_not_found')) throw new ParentNotFoundError();
        if (message.includes('attachment_validation_not_found')) throw new FileNotFoundError();
        throw new Error('Private file backend operation failed.');
      }
      if (result.data === null) return null;
      if (typeof result.data !== 'string' || !UUID_PATTERN.test(result.data)) {
        throw new Error('Attachment validation lease was not returned.');
      }
      return result.data;
    },

    async releaseValidation(workspaceId, attachmentId, storagePath, validationLeaseId) {
      const result = await client.rpc('release_attachment_validation', {
        p_workspace_id: workspaceId,
        p_attachment_id: attachmentId,
        p_expected_storage_path: storagePath,
        p_validation_lease_id: validationLeaseId,
      }) as Result;
      const released = dataOrThrow(result);
      if (typeof released !== 'boolean') throw new Error('Attachment validation release verdict was not returned.');
      return released;
    },

    async createSignedUploadUrl(storagePath) {
      const result = await bucket.createSignedUploadUrl(storagePath, { upsert: false });
      const data = dataOrThrow(result as Result) as { signedUrl?: unknown };
      if (typeof data.signedUrl !== 'string') throw new Error('Signed upload URL was not returned.');
      return data.signedUrl;
    },

    async getAttachment(workspaceId, attachmentId) {
      const result = await client.from('attachments').select(ATTACHMENT_COLUMNS)
        .eq('workspace_id', workspaceId).eq('id', attachmentId).is('deleted_at', null).maybeSingle() as Result;
      const data = dataOrThrow(result);
      return data === null ? null : storedAttachment(data);
    },

    async downloadObject(storagePath) {
      const result = await bucket.download(storagePath);
      const data = dataOrThrow(result as Result);
      if (!(data instanceof Blob)) throw new Error('Storage download did not return file bytes.');
      return new Uint8Array(await data.arrayBuffer());
    },

    async uploadReadyObject(storagePath, bytes, mimeType) {
      const result = await bucket.upload(storagePath, bytes, {
        cacheControl: '0',
        contentType: mimeType,
        upsert: false,
      });
      dataOrThrow(result as Result);
    },

    async completeUpload(record: StoredAttachment, ready: ReadyAttachmentMutation, validationLeaseId: string) {
      const result = await client.rpc('complete_attachment_upload', {
        p_workspace_id: record.workspaceId,
        p_attachment_id: record.id,
        p_expected_quarantine_path: record.storagePath,
        p_ready_path: ready.storagePath,
        p_name: ready.name,
        p_mime_type: ready.mimeType,
        p_size_bytes: ready.size,
        p_sha256: ready.sha256,
        p_validation_lease_id: validationLeaseId,
      }) as Result;
      const data = dataOrThrow(result);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('Completed attachment was not returned.');
      return storedAttachment(row);
    },

    async queueObjectCleanup(workspaceId, storagePath, attachmentId) {
      const result = await client.rpc('arm_attachment_ready_cleanup', {
        p_workspace_id: workspaceId,
        p_attachment_id: attachmentId,
        p_ready_path: storagePath,
      }) as Result;
      const queueId = dataOrThrow(result);
      if (queueId === null) return false;
      if (typeof queueId !== 'string' || !UUID_PATTERN.test(queueId)) {
        throw new Error('Private file cleanup guard was not established.');
      }
      return true;
    },

    async listExpiredQuarantines(now, limit) {
      const result = await client.from('attachments').select(ATTACHMENT_COLUMNS)
        .eq('state', 'quarantine').is('deleted_at', null).lte('quarantine_expires_at', now)
        .order('quarantine_expires_at').limit(limit) as Result;
      const data = dataOrThrow(result);
      return (Array.isArray(data) ? data : []).map(storedAttachment);
    },

    async listQueuedObjects(now, limit) {
      const result = await client.from('file_cleanup_queue').select('id,workspace_id,storage_path')
        .lte('remove_after', now).order('remove_after').limit(limit) as Result;
      const data = dataOrThrow(result);
      return (Array.isArray(data) ? data : []).map((value): QueuedObject => {
        const row = value as Record<string, unknown>;
        return { id: String(row.id), workspaceId: String(row.workspace_id), storagePath: String(row.storage_path) };
      });
    },

    async prepareQueuedObjectRemoval(id) {
      const result = await client.rpc('prepare_file_cleanup_object', { p_queue_id: id }) as Result;
      const data = dataOrThrow(result);
      return typeof data === 'string' ? data : null;
    },

    async finishQueuedObjectRemoval(id, leaseId) {
      const result = await client.rpc('finish_file_cleanup_object', {
        p_queue_id: id,
        p_lease_id: leaseId,
      }) as Result;
      const data = dataOrThrow(result);
      return data === true;
    },

    async removeObject(storagePath) {
      const result = await bucket.remove([storagePath]) as Result;
      if (result.error && !isMissingStorageObject(result.error)) dataOrThrow(result);
    },

    async createSignedDownloadUrl(storagePath, expiresIn, downloadName) {
      const result = await bucket.createSignedUrl(storagePath, expiresIn, { download: downloadName });
      const data = dataOrThrow(result as Result) as { signedUrl?: unknown };
      if (typeof data.signedUrl !== 'string') throw new Error('Signed download URL was not returned.');
      return data.signedUrl;
    },

    async setAttachmentDeleted(workspaceId, attachmentId, expectedVersion, restore) {
      const result = await client.rpc('set_attachment_deleted', {
        p_workspace_id: workspaceId,
        p_attachment_id: attachmentId,
        p_expected_version: expectedVersion,
        p_restore: restore,
      }) as Result;
      if (result.error) {
        const message = String(result.error.message ?? '');
        const conflict = /version_conflict:(\d+)/u.exec(message);
        if (conflict) throw new FileMutationError('version_conflict', expectedVersion, Number(conflict[1]));
        if (message.includes('restore_expired')) throw new FileMutationError('restore_expired');
        if (message.includes('restore_not_deleted')) throw new FileMutationError('restore_not_deleted');
        if (message.includes('attachment_not_found')) throw new FileMutationError('file_not_found');
        if (message.includes('attachment_parent_not_found')) throw new FileMutationError('parent_not_found');
        if (message.includes('attachment_not_ready')) throw new FileMutationError('file_not_ready');
        throw new Error('Private file backend operation failed.');
      }
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row) throw new Error('Attachment mutation did not return a record.');
      return storedAttachment(row);
    },
  };
}
