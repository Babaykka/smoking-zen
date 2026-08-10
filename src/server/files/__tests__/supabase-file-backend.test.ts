// @vitest-environment node

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createSupabaseFileBackend } from '@/server/files/supabase-file-backend';
import { UploadQuotaExceededError } from '@/server/files/file-store';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';
const validationLeaseId = '44444444-4444-4444-8444-444444444444';

const quarantineRow = {
  id: attachmentId, workspace_id: workspaceId, task_id: '55555555-5555-4555-8555-555555555555', knowledge_item_id: null,
  name: 'scheme.pdf', mime_type: 'application/pdf', size_bytes: 2048, storage_path: '66666666-6666-4666-8666-666666666666',
  state: 'quarantine', sha256: null, quarantine_expires_at: '2026-08-02T14:05:00.000Z', completed_at: null,
  version: 1, deleted_at: null,
};

function backendWithArmResult(data: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data, error: null });
  const storage = { from: vi.fn(() => ({})) };
  const backend = createSupabaseFileBackend({ rpc, storage } as unknown as SupabaseClient);
  return { backend, rpc };
}

describe('Supabase private-file backend', () => {
  it('reserves through the atomic DB quota RPC and maps a quota verdict', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [quarantineRow], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'upload_member_byte_quota_exceeded' } });
    const backend = createSupabaseFileBackend({ rpc, storage: { from: vi.fn(() => ({})) } } as unknown as SupabaseClient);
    const record = {
      id: attachmentId, workspaceId, taskId: quarantineRow.task_id, knowledgeItemId: null,
      name: 'scheme.pdf', mimeType: 'application/pdf', size: 2048, storagePath: quarantineRow.storage_path,
      state: 'quarantine' as const, sha256: null, quarantineExpiresAt: quarantineRow.quarantine_expires_at,
      completedAt: null, version: 1, deletedAt: null, createdBy: '77777777-7777-4777-8777-777777777777',
    };

    await expect(backend.reserveQuarantine(record)).resolves.toMatchObject({
      id: attachmentId, quarantineExpiresAt: '2026-08-02T14:05:00.000Z', version: 1,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'reserve_attachment_upload', {
      p_workspace_id: workspaceId, p_attachment_id: attachmentId, p_task_id: quarantineRow.task_id,
      p_knowledge_item_id: null, p_created_by: record.createdBy, p_name: 'scheme.pdf',
      p_mime_type: 'application/pdf', p_size_bytes: 2048, p_storage_path: quarantineRow.storage_path,
    });
    await expect(backend.reserveQuarantine(record)).rejects.toBeInstanceOf(UploadQuotaExceededError);
  });

  it('claims, releases, and completes with the same opaque validation lease', async () => {
    const readyRow = {
      ...quarantineRow, state: 'ready', storage_path: attachmentId, sha256: 'a'.repeat(64),
      quarantine_expires_at: null, completed_at: '2026-08-02T12:00:00.000Z', version: 2,
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: validationLeaseId, error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [readyRow], error: null });
    const backend = createSupabaseFileBackend({ rpc, storage: { from: vi.fn(() => ({})) } } as unknown as SupabaseClient);
    const record = {
      id: attachmentId, workspaceId, taskId: quarantineRow.task_id, knowledgeItemId: null,
      name: 'scheme.pdf', mimeType: 'application/pdf', size: 2048, storagePath: quarantineRow.storage_path,
      state: 'quarantine' as const, sha256: null, quarantineExpiresAt: quarantineRow.quarantine_expires_at,
      completedAt: null, version: 1, deletedAt: null,
    };

    await expect(backend.claimValidation(workspaceId, attachmentId, record.storagePath)).resolves.toBe(validationLeaseId);
    await expect(backend.releaseValidation(workspaceId, attachmentId, record.storagePath, validationLeaseId)).resolves.toBe(true);
    await expect(backend.completeUpload(record, {
      name: record.name, mimeType: record.mimeType, size: record.size,
      sha256: 'a'.repeat(64), storagePath: attachmentId,
    }, validationLeaseId)).resolves.toMatchObject({ state: 'ready', version: 2 });
    expect(rpc).toHaveBeenNthCalledWith(1, 'claim_attachment_validation', {
      p_workspace_id: workspaceId, p_attachment_id: attachmentId, p_expected_storage_path: record.storagePath,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'release_attachment_validation', {
      p_workspace_id: workspaceId, p_attachment_id: attachmentId,
      p_expected_storage_path: record.storagePath, p_validation_lease_id: validationLeaseId,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'complete_attachment_upload', expect.objectContaining({
      p_validation_lease_id: validationLeaseId,
    }));
  });

  it('soft-cancels a pre-grant reservation without calling Storage delete', async () => {
    const remove = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const backend = createSupabaseFileBackend({
      rpc, storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient);

    await expect(backend.cancelReservation(workspaceId, attachmentId, quarantineRow.storage_path))
      .resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('cancel_attachment_upload_reservation', {
      p_workspace_id: workspaceId, p_attachment_id: attachmentId,
      p_expected_storage_path: quarantineRow.storage_path,
    });
    expect(remove).not.toHaveBeenCalled();
  });
  it('uses the DB-clock attachment transition RPC and returns versioned public metadata', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{
      id: attachmentId, workspace_id: workspaceId, task_id: '44444444-4444-4444-8444-444444444444', knowledge_item_id: null,
      name: 'scheme.pdf', mime_type: 'application/pdf', size_bytes: 2048, storage_path: attachmentId,
      state: 'ready', sha256: 'a'.repeat(64), quarantine_expires_at: null, completed_at: '2026-08-02T12:00:00.000Z',
      version: 4, deleted_at: '2026-08-02T13:00:00.000Z',
    }], error: null });
    const backend = createSupabaseFileBackend({ rpc, storage: { from: vi.fn(() => ({})) } } as unknown as SupabaseClient);

    await expect(backend.setAttachmentDeleted(workspaceId, attachmentId, 3, false)).resolves.toMatchObject({
      id: attachmentId, version: 4, deletedAt: '2026-08-02T13:00:00.000Z', state: 'ready',
    });
    expect(rpc).toHaveBeenCalledWith('set_attachment_deleted', {
      p_workspace_id: workspaceId, p_attachment_id: attachmentId, p_expected_version: 3, p_restore: false,
    });
  });

  it('maps a database version verdict without leaking provider details', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'version_conflict:7' } });
    const backend = createSupabaseFileBackend({ rpc, storage: { from: vi.fn(() => ({})) } } as unknown as SupabaseClient);

    await expect(backend.setAttachmentDeleted(workspaceId, attachmentId, 6, false)).rejects.toEqual(
      expect.objectContaining({ code: 'version_conflict', expectedVersion: 6, actualVersion: 7 }),
    );
  });

  it('lists only live expired quarantine rows so bounded cleanup batches advance past retired metadata', async () => {
    const limit = vi.fn().mockResolvedValue({
      data: [{
        id: attachmentId,
        workspace_id: workspaceId,
        task_id: null,
        knowledge_item_id: null,
        name: 'expired.txt',
        mime_type: 'text/plain',
        size_bytes: 16,
        storage_path: '33333333-3333-4333-8333-333333333333',
        state: 'quarantine',
        sha256: null,
        quarantine_expires_at: '2026-08-02T11:59:59.000Z',
        completed_at: null,
      }],
      error: null,
    });
    const order = vi.fn(() => ({ limit }));
    const lte = vi.fn(() => ({ order }));
    const is = vi.fn(() => ({ lte }));
    const eq = vi.fn(() => ({ is, lte }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const client = {
      from,
      storage: { from: vi.fn(() => ({})) },
    } as unknown as SupabaseClient;
    const backend = createSupabaseFileBackend(client);

    await expect(backend.listExpiredQuarantines('2026-08-02T12:00:00.000Z', 20))
      .resolves.toEqual([expect.objectContaining({ id: attachmentId, state: 'quarantine' })]);
    expect(from).toHaveBeenCalledWith('attachments');
    expect(eq).toHaveBeenCalledWith('state', 'quarantine');
    expect(is).toHaveBeenCalledWith('deleted_at', null);
    expect(lte).toHaveBeenCalledWith('quarantine_expires_at', '2026-08-02T12:00:00.000Z');
    expect(limit).toHaveBeenCalledWith(20);
  });

  it('returns false when the database clock refuses to arm cleanup after quarantine expiry', async () => {
    const { backend } = backendWithArmResult(null);

    await expect(backend.queueObjectCleanup(workspaceId, attachmentId, attachmentId)).resolves.toBe(false);
  });

  it.each(['', 'not-a-uuid'])('rejects an invalid cleanup guard result before a ready write: %j', async (data) => {
    const { backend } = backendWithArmResult(data);

    await expect(backend.queueObjectCleanup(workspaceId, attachmentId, attachmentId))
      .rejects.toThrow(/cleanup guard/iu);
  });

  it('accepts a durable UUID cleanup guard returned by the database clock RPC', async () => {
    const queueId = '33333333-3333-4333-8333-333333333333';
    const { backend, rpc } = backendWithArmResult(queueId);

    await expect(backend.queueObjectCleanup(workspaceId, attachmentId, attachmentId)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('arm_attachment_ready_cleanup', {
      p_workspace_id: workspaceId,
      p_attachment_id: attachmentId,
      p_ready_path: attachmentId,
    });
  });

  it.each([
    ['expired', true],
    ['parent_missing', true],
    ['invalid_content', false],
  ] as const)('uses the reasoned database retirement RPC without touching Storage: %s', async (reason, retired) => {
    const remove = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ data: retired, error: null });
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient;
    const backend = createSupabaseFileBackend(client);

    await expect(backend.retireQuarantine(workspaceId, attachmentId, attachmentId, reason))
      .resolves.toBe(retired);
    expect(rpc).toHaveBeenCalledWith('retire_quarantine_attachment', {
      p_workspace_id: workspaceId,
      p_attachment_id: attachmentId,
      p_expected_storage_path: attachmentId,
      p_reason: reason,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('authorizes retirement in the database before ordinary cleanup treats a missing object as removed', async () => {
    const remove = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Object not found', statusCode: '404' },
    });
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const client = {
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient;
    const backend = createSupabaseFileBackend(client);

    await expect(backend.retireQuarantine(workspaceId, attachmentId, attachmentId, 'expired')).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('retire_quarantine_attachment', {
      p_workspace_id: workspaceId,
      p_attachment_id: attachmentId,
      p_expected_storage_path: attachmentId,
      p_reason: 'expired',
    });
    expect(remove).not.toHaveBeenCalled();

    await expect(backend.removeObject(attachmentId)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith([attachmentId]);
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
  });

  it.each(['attachment_retire_not_expired', 'attachment_retire_not_found'])(
    'never touches Storage when database retirement rejects %s',
    async (message) => {
      const remove = vi.fn();
      const rpc = vi.fn().mockResolvedValue({ data: null, error: { message } });
      const client = {
        rpc,
        storage: { from: vi.fn(() => ({ remove })) },
      } as unknown as SupabaseClient;
      const backend = createSupabaseFileBackend(client);

      await expect(backend.retireQuarantine(workspaceId, attachmentId, attachmentId, 'expired')).rejects.toThrow();
      expect(remove).not.toHaveBeenCalled();
    },
  );
});
