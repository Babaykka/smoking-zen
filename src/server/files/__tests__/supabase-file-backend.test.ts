// @vitest-environment node

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createSupabaseFileBackend } from '@/server/files/supabase-file-backend';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';

function backendWithArmResult(data: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data, error: null });
  const storage = { from: vi.fn(() => ({})) };
  const backend = createSupabaseFileBackend({ rpc, storage } as unknown as SupabaseClient);
  return { backend, rpc };
}

describe('Supabase private-file backend', () => {
  it.each([null, '', 'not-a-uuid'])('rejects an invalid cleanup guard result before a ready write: %j', async (data) => {
    const { backend } = backendWithArmResult(data);

    await expect(backend.queueObjectCleanup(workspaceId, attachmentId, attachmentId))
      .rejects.toThrow(/cleanup guard/iu);
  });

  it('accepts a durable UUID cleanup guard returned by the database clock RPC', async () => {
    const queueId = '33333333-3333-4333-8333-333333333333';
    const { backend, rpc } = backendWithArmResult(queueId);

    await expect(backend.queueObjectCleanup(workspaceId, attachmentId, attachmentId)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('arm_attachment_ready_cleanup', {
      p_workspace_id: workspaceId,
      p_attachment_id: attachmentId,
      p_ready_path: attachmentId,
    });
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
    const backend = createSupabaseFileBackend(client) as ReturnType<typeof createSupabaseFileBackend> & {
      retireExpiredQuarantine?: (workspace: string, attachment: string, path: string) => Promise<void>;
    };

    expect(backend.retireExpiredQuarantine).toBeTypeOf('function');
    await expect(backend.retireExpiredQuarantine!(workspaceId, attachmentId, attachmentId)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('retire_expired_quarantine_attachment', {
      p_workspace_id: workspaceId,
      p_attachment_id: attachmentId,
      p_expected_storage_path: attachmentId,
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

      await expect(backend.retireExpiredQuarantine(workspaceId, attachmentId, attachmentId)).rejects.toThrow();
      expect(remove).not.toHaveBeenCalled();
    },
  );
});
