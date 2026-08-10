// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { runCleanupCycle, type CleanupBackend } from '@/server/cleanup/coordinator';

const ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const LEASE = '33333333-3333-4333-8333-333333333333';

function backend(overrides: Partial<CleanupBackend> = {}): CleanupBackend {
  return {
    stageFileCleanup: vi.fn().mockResolvedValue(1),
    listFileCleanup: vi.fn().mockResolvedValue([]),
    prepareFileCleanup: vi.fn().mockResolvedValue(null),
    removeObject: vi.fn().mockResolvedValue(undefined),
    finishFileCleanup: vi.fn().mockResolvedValue(true),
    failFileCleanup: vi.fn().mockResolvedValue(true),
    discoverOrphans: vi.fn().mockResolvedValue(0),
    listOrphans: vi.fn().mockResolvedValue([]),
    prepareOrphan: vi.fn().mockResolvedValue(null),
    finishOrphan: vi.fn().mockResolvedValue(true),
    failOrphan: vi.fn().mockResolvedValue(true),
    purgeDeletedRecords: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('cleanup coordinator', () => {
  it('uses the fixed DB-clock phase order and never accepts a caller clock or batch', async () => {
    const calls: string[] = [];
    const store = backend({
      stageFileCleanup: vi.fn(async () => { calls.push('stage'); return 0; }),
      listFileCleanup: vi.fn(async () => { calls.push('files'); return []; }),
      discoverOrphans: vi.fn(async () => { calls.push('discover'); return 0; }),
      listOrphans: vi.fn(async () => { calls.push('orphans'); return []; }),
      purgeDeletedRecords: vi.fn(async () => { calls.push('purge'); return 0; }),
    });

    const result = await runCleanupCycle(store);
    expect(calls).toEqual(['stage', 'files', 'discover', 'orphans', 'purge', 'purge']);
    expect(result).toEqual({
      staged: 0, fileCandidates: 0, fileRemoved: 0, orphanDiscovered: 0,
      orphanCandidates: 0, orphanRemoved: 0, pending: 0, failed: 0, purged: 0,
    });
    expect(store.stageFileCleanup).toHaveBeenCalledWith();
    expect(store.purgeDeletedRecords).toHaveBeenCalledTimes(2);
  });

  it('validates keys before Storage, treats missing as success, and leaves false finishes pending', async () => {
    const removeObject = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'storage_not_found' }))
      .mockResolvedValueOnce(undefined);
    const store = backend({
      listFileCleanup: vi.fn().mockResolvedValue([
        { id: ID, workspaceId: WORKSPACE, storagePath: ID },
        { id: '44444444-4444-4444-8444-444444444444', workspaceId: WORKSPACE, storagePath: '../secret' },
      ]),
      prepareFileCleanup: vi.fn().mockResolvedValue(LEASE),
      finishFileCleanup: vi.fn().mockResolvedValue(false),
      listOrphans: vi.fn().mockResolvedValue([{ storagePath: ID }]),
      prepareOrphan: vi.fn().mockResolvedValue(LEASE),
      finishOrphan: vi.fn().mockResolvedValue(true),
      removeObject,
    });

    const result = await runCleanupCycle(store);
    expect(removeObject).toHaveBeenCalledTimes(2);
    expect(removeObject).toHaveBeenNthCalledWith(1, ID);
    expect(removeObject).toHaveBeenNthCalledWith(2, ID);
    expect(store.finishFileCleanup).toHaveBeenCalledWith(ID, LEASE);
    expect(result).toMatchObject({ fileCandidates: 2, fileRemoved: 0, orphanRemoved: 1, pending: 1, failed: 1 });
  });

  it('isolates provider failures, records only redacted orphan failure codes, and continues', async () => {
    const FIRST = '55555555-5555-4555-8555-555555555555';
    const removeObject = vi.fn()
      .mockRejectedValueOnce(new Error('LEAK_THIS_PROVIDER_SENTINEL'))
      .mockResolvedValueOnce(undefined);
    const store = backend({
      listOrphans: vi.fn().mockResolvedValue([{ storagePath: FIRST }, { storagePath: ID }]),
      prepareOrphan: vi.fn().mockResolvedValue(LEASE),
      removeObject,
    });
    const result = await runCleanupCycle(store);
    expect(store.failOrphan).toHaveBeenCalledWith(FIRST, LEASE, 'storage_unavailable');
    expect(store.finishOrphan).toHaveBeenCalledWith(ID, LEASE);
    expect(JSON.stringify(result)).not.toContain('LEAK_THIS_PROVIDER_SENTINEL');
    expect(result).toMatchObject({ orphanRemoved: 1, failed: 1 });
  });

  it('releases a failed file lease with only an enumerated redacted code', async () => {
    const store = backend({
      listFileCleanup: vi.fn().mockResolvedValue([{ id: ID, workspaceId: WORKSPACE, storagePath: ID }]),
      prepareFileCleanup: vi.fn().mockResolvedValue(LEASE),
      removeObject: vi.fn().mockRejectedValue(new Error('RAW_STORAGE_SENTINEL')),
    });
    const result = await runCleanupCycle(store);
    expect(store.failFileCleanup).toHaveBeenCalledWith(ID, LEASE, 'storage_unavailable');
    expect(store.finishFileCleanup).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('RAW_STORAGE_SENTINEL');
    expect(result.failed).toBe(1);
  });
});
