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

const FILE_BUCKET = 'workspace-files';

type Result = { data: unknown; error: { message?: string } | null };

function dataOrThrow(result: Result): unknown {
  if (result.error) throw new Error('Private file backend operation failed.');
  return result.data;
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
  };
}

const ATTACHMENT_COLUMNS = [
  'id', 'workspace_id', 'task_id', 'knowledge_item_id', 'name', 'mime_type', 'size_bytes',
  'storage_path', 'state', 'sha256', 'quarantine_expires_at', 'completed_at',
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

    async insertQuarantine(record: NewQuarantineAttachment) {
      const result = await client.from('attachments').insert({
        id: record.id,
        workspace_id: record.workspaceId,
        task_id: record.taskId,
        knowledge_item_id: record.knowledgeItemId,
        name: record.name,
        mime_type: record.mimeType,
        size_bytes: record.size,
        storage_path: record.storagePath,
        state: 'quarantine',
        sha256: null,
        created_by: record.createdBy,
        quarantine_expires_at: record.quarantineExpiresAt,
        completed_at: null,
      }) as Result;
      dataOrThrow(result);
    },

    async deleteQuarantine(workspaceId, attachmentId, storagePath) {
      const storageResult = await bucket.remove([storagePath]);
      dataOrThrow(storageResult as Result);
      const result = await client.from('attachments').delete()
        .eq('workspace_id', workspaceId).eq('id', attachmentId).eq('state', 'quarantine') as Result;
      dataOrThrow(result);
    },

    async expireQuarantine(workspaceId, attachmentId) {
      const result = await client.from('attachments').update({ quarantine_expires_at: new Date(0).toISOString() })
        .eq('workspace_id', workspaceId).eq('id', attachmentId).eq('state', 'quarantine') as Result;
      dataOrThrow(result);
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

    async completeUpload(record: StoredAttachment, ready: ReadyAttachmentMutation) {
      const result = await client.rpc('complete_attachment_upload', {
        p_workspace_id: record.workspaceId,
        p_attachment_id: record.id,
        p_expected_quarantine_path: record.storagePath,
        p_ready_path: ready.storagePath,
        p_name: ready.name,
        p_mime_type: ready.mimeType,
        p_size_bytes: ready.size,
        p_sha256: ready.sha256,
      }) as Result;
      const data = dataOrThrow(result);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('Completed attachment was not returned.');
      return storedAttachment(row);
    },

    async queueObjectCleanup(workspaceId, storagePath) {
      const result = await client.from('file_cleanup_queue').upsert({
        workspace_id: workspaceId,
        storage_path: storagePath,
        remove_after: new Date().toISOString(),
      }, { onConflict: 'workspace_id,storage_path' }) as Result;
      dataOrThrow(result);
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

    async deleteQueuedObject(id) {
      const result = await client.from('file_cleanup_queue').delete().eq('id', id) as Result;
      dataOrThrow(result);
    },

    async removeObject(storagePath) {
      const result = await bucket.remove([storagePath]);
      dataOrThrow(result as Result);
    },

    async createSignedDownloadUrl(storagePath, expiresIn, downloadName) {
      const result = await bucket.createSignedUrl(storagePath, expiresIn, { download: downloadName });
      const data = dataOrThrow(result as Result) as { signedUrl?: unknown };
      if (typeof data.signedUrl !== 'string') throw new Error('Signed download URL was not returned.');
      return data.signedUrl;
    },
  };
}
