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
});
