import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  CleanupBackend,
  CleanupFailureCode,
  FileCleanupCandidate,
  OrphanCleanupCandidate,
} from '@/server/cleanup/coordinator';

const FILE_BUCKET = 'workspace-files';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ResultError = { status?: number | string; statusCode?: number | string };
type Result = { data: unknown; error: ResultError | null };

export class CleanupStoreError extends Error {
  constructor(message = 'Cleanup persistence operation failed.') {
    super(message);
    this.name = 'CleanupStoreError';
  }
}

function data(result: Result): unknown {
  if (result.error) throw new CleanupStoreError();
  return result.data;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CleanupStoreError();
  return Number(value);
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new CleanupStoreError();
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))) {
    throw new CleanupStoreError();
  }
  return value as Record<string, unknown>[];
}

function fileCandidate(row: Record<string, unknown>): FileCleanupCandidate {
  if (typeof row.storage_path !== 'string') throw new CleanupStoreError();
  return { id: uuid(row.id), workspaceId: uuid(row.workspace_id), storagePath: row.storage_path };
}

function orphanCandidate(row: Record<string, unknown>): OrphanCleanupCandidate {
  return { storagePath: uuid(row.storage_path) };
}

function lease(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function verdict(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new CleanupStoreError();
  return value;
}

export function createSupabaseCleanupBackend(client: SupabaseClient): CleanupBackend {
  const bucket = client.storage.from(FILE_BUCKET);
  return {
    async stageFileCleanup() {
      return integer(data(await client.rpc('stage_file_cleanup', {}) as Result));
    },
    async listFileCleanup() {
      return rows(data(await client.rpc('list_due_file_cleanup', {}) as Result)).map(fileCandidate);
    },
    async prepareFileCleanup(id) {
      return lease(data(await client.rpc('prepare_file_cleanup_object', { p_queue_id: id }) as Result));
    },
    async removeObject(storagePath) {
      const result = await bucket.remove([storagePath]) as Result;
      if (!result.error) return;
      if (Number(result.error.statusCode ?? result.error.status) === 404) return;
      throw new CleanupStoreError('Storage cleanup operation failed.');
    },
    async finishFileCleanup(id, leaseId) {
      return verdict(data(await client.rpc('finish_file_cleanup_object', {
        p_queue_id: id, p_lease_id: leaseId,
      }) as Result));
    },
    async failFileCleanup(id, leaseId, errorCode) {
      return verdict(data(await client.rpc('fail_file_cleanup_object', {
        p_queue_id: id, p_lease_id: leaseId, p_error_code: errorCode,
      }) as Result));
    },
    async discoverOrphans() {
      return integer(data(await client.rpc('discover_global_file_orphans', {}) as Result));
    },
    async listOrphans() {
      return rows(data(await client.rpc('list_due_global_file_orphans', {}) as Result)).map(orphanCandidate);
    },
    async prepareOrphan(storagePath) {
      return lease(data(await client.rpc('prepare_global_file_orphan', { p_storage_path: storagePath }) as Result));
    },
    async finishOrphan(storagePath, leaseId) {
      return verdict(data(await client.rpc('finish_global_file_orphan', {
        p_storage_path: storagePath, p_lease_id: leaseId,
      }) as Result));
    },
    async failOrphan(storagePath: string, leaseId: string, errorCode: CleanupFailureCode) {
      return verdict(data(await client.rpc('fail_global_file_orphan', {
        p_storage_path: storagePath, p_lease_id: leaseId, p_error_code: errorCode,
      }) as Result));
    },
    async purgeDeletedRecords() {
      return integer(data(await client.rpc('purge_deleted_records', {}) as Result));
    },
  };
}
