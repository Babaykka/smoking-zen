// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { CleanupStoreError, createSupabaseCleanupBackend } from '@/server/cleanup/supabase-cleanup-backend';

const ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const LEASE = '33333333-3333-4333-8333-333333333333';

function clientFor(
  results: Array<{ data: unknown; error: unknown }>,
  removeResult: { data: unknown; error: unknown } = { data: [], error: null },
) {
  const rpc = vi.fn(async () => results.shift() ?? { data: null, error: null });
  const remove = vi.fn(async () => removeResult);
  return { client: { rpc, storage: { from: vi.fn(() => ({ remove })) } } as never, rpc, remove };
}

describe('Supabase cleanup backend', () => {
  it('strictly parses file and orphan candidates and rejects raw database errors', async () => {
    const fixture = clientFor([
      { data: [{ id: ID, workspace_id: WORKSPACE, storage_path: ID }], error: null },
      { data: [{ storage_path: ID }], error: null },
      { data: [{ id: 'not-a-uuid', workspace_id: WORKSPACE, storage_path: ID }], error: null },
    ]);
    const backend = createSupabaseCleanupBackend(fixture.client);
    await expect(backend.listFileCleanup()).resolves.toEqual([{ id: ID, workspaceId: WORKSPACE, storagePath: ID }]);
    await expect(backend.listOrphans()).resolves.toEqual([{ storagePath: ID }]);
    await expect(backend.listFileCleanup()).rejects.toBeInstanceOf(CleanupStoreError);

    const failed = clientFor([{ data: null, error: { message: 'DATABASE_SECRET_SENTINEL' } }]);
    await expect(createSupabaseCleanupBackend(failed.client).stageFileCleanup())
      .rejects.toThrow('Cleanup persistence operation failed.');
  });

  it('uses exact RPC shapes and maps Storage 404 to success without exposing paths', async () => {
    const fixture = clientFor([
      { data: LEASE, error: null },
      { data: false, error: null },
      { data: true, error: null },
    ], { data: null, error: { statusCode: 404, message: 'not found' } });
    const backend = createSupabaseCleanupBackend(fixture.client);
    await expect(backend.prepareFileCleanup(ID)).resolves.toBe(LEASE);
    await expect(backend.finishFileCleanup(ID, LEASE)).resolves.toBe(false);
    await expect(backend.removeObject(ID)).resolves.toBeUndefined();
    await expect(backend.failOrphan(ID, LEASE, 'storage_unavailable')).resolves.toBe(true);
    expect(fixture.rpc).toHaveBeenNthCalledWith(1, 'prepare_file_cleanup_object', { p_queue_id: ID });
    expect(fixture.rpc).toHaveBeenNthCalledWith(2, 'finish_file_cleanup_object', { p_queue_id: ID, p_lease_id: LEASE });
    expect(fixture.rpc).toHaveBeenNthCalledWith(3, 'fail_global_file_orphan', {
      p_storage_path: ID, p_lease_id: LEASE, p_error_code: 'storage_unavailable',
    });
  });

  it('exposes a lost failure lease and rejects malformed boolean persistence verdicts', async () => {
    const fixture = clientFor([
      { data: false, error: null },
      { data: null, error: null },
    ]);
    const backend = createSupabaseCleanupBackend(fixture.client);
    await expect(backend.failOrphan(ID, LEASE, 'storage_unavailable')).resolves.toBe(false);
    await expect(backend.failFileCleanup(ID, LEASE, 'storage_unavailable'))
      .rejects.toBeInstanceOf(CleanupStoreError);
  });
});
