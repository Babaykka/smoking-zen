// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { validateUpload } from '@/domain/files';
import {
  FileNotFoundError,
  FileNotReadyError,
  ParentNotFoundError,
  UploadExpiredError,
  createPrivateFileStore,
  type FileBackend,
  type StoredAttachment,
} from '@/server/files/file-store';

const workspaceId = '33333333-3333-4333-8333-333333333333';
const actorUserId = '11111111-1111-4111-8111-111111111111';
const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const quarantineObjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const readyObjectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const cleanupLeaseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const bytes = Buffer.from('Безопасный регламент смены.\n', 'utf8');

const quarantine: StoredAttachment = {
  id: attachmentId,
  workspaceId,
  taskId: '44444444-4444-4444-8444-444444444444',
  knowledgeItemId: null,
  name: 'policy.txt',
  mimeType: 'text/plain',
  size: bytes.length,
  storagePath: quarantineObjectId,
  state: 'quarantine',
  sha256: null,
  quarantineExpiresAt: '2026-08-02T14:05:00.000Z',
  completedAt: null,
};

function backend(overrides: Partial<FileBackend> = {}): FileBackend {
  return {
    parentExists: vi.fn().mockResolvedValue(true),
    insertQuarantine: vi.fn().mockResolvedValue(undefined),
    deleteQuarantine: vi.fn().mockResolvedValue(undefined),
    expireQuarantine: vi.fn().mockResolvedValue(undefined),
    createSignedUploadUrl: vi.fn().mockImplementation(async (storagePath: string) =>
      `https://storage.example/storage/v1/object/upload/sign/workspace-files/${storagePath}?token=ephemeral`),
    getAttachment: vi.fn().mockResolvedValue(quarantine),
    downloadObject: vi.fn().mockResolvedValue(bytes),
    uploadReadyObject: vi.fn().mockResolvedValue(undefined),
    completeUpload: vi.fn().mockImplementation(async (_record, ready) => ({
      ...quarantine,
      name: ready.name,
      mimeType: ready.mimeType,
      size: ready.size,
      sha256: ready.sha256,
      storagePath: ready.storagePath,
      state: 'ready' as const,
      quarantineExpiresAt: null,
      completedAt: '2026-08-02T12:00:00.000Z',
    })),
    queueObjectCleanup: vi.fn().mockResolvedValue(undefined),
    listExpiredQuarantines: vi.fn().mockResolvedValue([]),
    listQueuedObjects: vi.fn().mockResolvedValue([]),
    prepareQueuedObjectRemoval: vi.fn().mockResolvedValue(cleanupLeaseId),
    finishQueuedObjectRemoval: vi.fn().mockResolvedValue(true),
    removeObject: vi.fn().mockResolvedValue(undefined),
    createSignedDownloadUrl: vi.fn().mockResolvedValue('https://storage.example/private-download?token=ephemeral'),
    ...overrides,
  };
}

function preflight() {
  return validateUpload({ name: 'policy.txt', declaredMime: 'text/plain', size: bytes.length, headerBytes: bytes });
}

function idFactory() {
  const ids = [attachmentId, quarantineObjectId, readyObjectId];
  return () => ids.shift() ?? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
}

describe('private file lifecycle store', () => {
  it('creates a randomized quarantine row before issuing an ephemeral signed upload URL', async () => {
    const fileBackend = backend();
    const store = createPrivateFileStore(fileBackend, {
      idFactory: idFactory(),
      clock: () => new Date('2026-08-02T12:00:00.000Z'),
    });
    const signed = await store.signUpload(workspaceId, actorUserId, {
      parent: { type: 'task', id: quarantine.taskId! },
      file: preflight(),
    });

    expect(fileBackend.parentExists).toHaveBeenCalledWith(workspaceId, { type: 'task', id: quarantine.taskId });
    expect(fileBackend.insertQuarantine).toHaveBeenCalledWith(expect.objectContaining({
      id: attachmentId,
      workspaceId,
      taskId: quarantine.taskId,
      knowledgeItemId: null,
      storagePath: quarantineObjectId,
      createdBy: actorUserId,
      state: 'quarantine',
    }));
    expect(JSON.stringify(vi.mocked(fileBackend.insertQuarantine).mock.calls)).not.toContain('private-upload');
    expect(signed).toMatchObject({
      id: attachmentId,
      uploadUrl: `https://storage.example/storage/v1/object/upload/sign/workspace-files/${quarantineObjectId}?token=ephemeral`,
      name: 'policy.txt',
      mimeType: 'text/plain',
      size: bytes.length,
    });
    expect(signed.expiresAt).toBe('2026-08-02T14:05:00.000Z');
  });

  it('deletes the quarantine row if signed-URL creation fails', async () => {
    const fileBackend = backend({ createSignedUploadUrl: vi.fn().mockRejectedValue(new Error('provider secret token')) });
    const store = createPrivateFileStore(fileBackend, { idFactory: idFactory() });
    await expect(store.signUpload(workspaceId, actorUserId, {
      parent: { type: 'task', id: quarantine.taskId! }, file: preflight(),
    })).rejects.toThrow('Не удалось подготовить загрузку файла.');
    expect(fileBackend.deleteQuarantine).toHaveBeenCalledWith(workspaceId, attachmentId, quarantineObjectId);
  });

  it('validates every uploaded byte, writes a new ready object, and atomically queues the quarantine object for cleanup', async () => {
    const fileBackend = backend();
    const store = createPrivateFileStore(fileBackend, {
      idFactory: idFactory(),
      clock: () => new Date('2026-08-02T12:00:00.000Z'),
    });
    const completed = await store.completeUpload(workspaceId, attachmentId);

    expect(fileBackend.downloadObject).toHaveBeenCalledWith(quarantine.storagePath);
    expect(fileBackend.uploadReadyObject).toHaveBeenCalledWith(
      attachmentId,
      bytes,
      'text/plain',
    );
    expect(fileBackend.completeUpload).toHaveBeenCalledWith(quarantine, expect.objectContaining({
      storagePath: attachmentId,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(completed).toEqual({ id: attachmentId, name: 'policy.txt', mimeType: 'text/plain', size: bytes.length });
  });

  it('reconciles an RPC response loss after completion committed with cleanup established before external writes', async () => {
    let authoritative: StoredAttachment = quarantine;
    const completeUpload = vi.fn().mockImplementation(async (_record, ready) => {
      authoritative = {
        ...quarantine,
        name: ready.name,
        mimeType: ready.mimeType,
        size: ready.size,
        sha256: ready.sha256,
        storagePath: ready.storagePath,
        state: 'ready',
        quarantineExpiresAt: null,
        completedAt: '2026-08-02T12:00:00.000Z',
      };
      throw new Error('transport closed after commit');
    });
    const fileBackend = backend({
      completeUpload,
      getAttachment: vi.fn().mockImplementation(async () => authoritative),
    });
    const store = createPrivateFileStore(fileBackend, {
      idFactory: idFactory(),
      clock: () => new Date('2026-08-02T12:00:00.000Z'),
    });

    await expect(store.completeUpload(workspaceId, attachmentId)).resolves.toEqual({
      id: attachmentId,
      name: 'policy.txt',
      mimeType: 'text/plain',
      size: bytes.length,
    });
    expect(authoritative).toMatchObject({ state: 'ready', storagePath: attachmentId });
    expect(fileBackend.queueObjectCleanup).toHaveBeenCalledWith(
      workspaceId,
      attachmentId,
      attachmentId,
    );
    expect(vi.mocked(fileBackend.queueObjectCleanup).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fileBackend.uploadReadyObject).mock.invocationCallOrder[0]!);
    expect(vi.mocked(fileBackend.uploadReadyObject).mock.invocationCallOrder[0])
      .toBeLessThan(completeUpload.mock.invocationCallOrder[0]!);
  });

  it('reconciles a ready-object upload that committed before its response failed', async () => {
    const storedObjects = new Map<string, Uint8Array>([[quarantine.storagePath, bytes]]);
    const fileBackend = backend({
      downloadObject: vi.fn().mockImplementation(async (storagePath: string) => {
        const stored = storedObjects.get(storagePath);
        if (!stored) throw new Error('object missing');
        return stored;
      }),
      uploadReadyObject: vi.fn().mockImplementation(async (storagePath: string, uploaded: Uint8Array) => {
        storedObjects.set(storagePath, uploaded);
        throw new Error('transport closed after object commit');
      }),
    });
    const store = createPrivateFileStore(fileBackend, {
      idFactory: idFactory(),
      clock: () => new Date('2026-08-02T12:00:00.000Z'),
    });

    await expect(store.completeUpload(workspaceId, attachmentId)).resolves.toEqual({
      id: attachmentId,
      name: 'policy.txt',
      mimeType: 'text/plain',
      size: bytes.length,
    });
    expect(fileBackend.uploadReadyObject).toHaveBeenCalledWith(attachmentId, bytes, 'text/plain');
    expect(fileBackend.completeUpload).toHaveBeenCalledWith(quarantine, expect.objectContaining({ storagePath: attachmentId }));
  });

  it('queues an unresolved ambiguous ready-object upload until completion can no longer reference it', async () => {
    const fileBackend = backend({
      downloadObject: vi.fn().mockImplementation(async (storagePath: string) => {
        if (storagePath === quarantine.storagePath) return bytes;
        throw new Error('ambiguous ready object cannot be read');
      }),
      uploadReadyObject: vi.fn().mockRejectedValue(new Error('ambiguous provider failure')),
    });
    const store = createPrivateFileStore(fileBackend, {
      idFactory: idFactory(),
      clock: () => new Date('2026-08-02T12:00:00.000Z'),
    });

    await expect(store.completeUpload(workspaceId, attachmentId)).rejects.toThrow('Не удалось сохранить проверенный файл.');
    expect(fileBackend.queueObjectCleanup).toHaveBeenCalledWith(
      workspaceId,
      attachmentId,
      attachmentId,
    );
    expect(fileBackend.removeObject).not.toHaveBeenCalledWith(attachmentId);
  });

  it('retains a DB-backed tombstone when a ready write commits after the first expiry sweep', async () => {
    const expiry = new Date(quarantine.quarantineExpiresAt!);
    const guardEnd = new Date(expiry.getTime() + 24 * 60 * 60 * 1_000);
    const storedObjects = new Map<string, Uint8Array>([[quarantine.storagePath, bytes]]);
    let queued = false;
    let queueDueAt = expiry.getTime();
    let sweepTime = expiry.getTime();
    let releaseReadyWrite!: () => void;
    let markReadyWriteStarted!: () => void;
    const readyWriteStarted = new Promise<void>((resolve) => { markReadyWriteStarted = resolve; });
    const readyWriteCanCommit = new Promise<void>((resolve) => { releaseReadyWrite = resolve; });
    const fileBackend = backend({
      queueObjectCleanup: vi.fn().mockImplementation(async () => { queued = true; }),
      listQueuedObjects: vi.fn().mockImplementation(async (now: string) => {
        sweepTime = Date.parse(now);
        return queued && queueDueAt <= sweepTime
          ? [{ id: 'queue-late-ready', workspaceId, storagePath: attachmentId }]
          : [];
      }),
      prepareQueuedObjectRemoval: vi.fn().mockResolvedValue(cleanupLeaseId),
      removeObject: vi.fn().mockImplementation(async (storagePath: string) => { storedObjects.delete(storagePath); }),
      uploadReadyObject: vi.fn().mockImplementation(async (storagePath: string, uploaded: Uint8Array) => {
        markReadyWriteStarted();
        await readyWriteCanCommit;
        storedObjects.set(storagePath, uploaded);
      }),
      completeUpload: vi.fn().mockRejectedValue(new Error('database clock rejected expired completion')),
      finishQueuedObjectRemoval: vi.fn().mockImplementation(async () => {
        if (sweepTime < guardEnd.getTime()) {
          queueDueAt = guardEnd.getTime();
          return false;
        }
        queued = false;
        return true;
      }),
    });
    const store = createPrivateFileStore(fileBackend, { clock: () => new Date('2026-08-02T12:00:00.000Z') });

    const completion = store.completeUpload(workspaceId, attachmentId);
    await readyWriteStarted;

    await store.cleanupExpiredUploads(expiry, 20);
    expect(storedObjects.has(attachmentId)).toBe(false);
    expect(queued).toBe(true);

    releaseReadyWrite();
    await expect(completion).rejects.toThrow('Не удалось завершить загрузку файла.');
    expect(storedObjects.has(attachmentId)).toBe(true);

    await store.cleanupExpiredUploads(guardEnd, 20);
    expect(storedObjects.has(attachmentId)).toBe(false);
    expect(queued).toBe(false);
  });

  it('denies completion and discards quarantine when the parent was deleted after signing', async () => {
    const fileBackend = backend({ parentExists: vi.fn().mockResolvedValue(false) });
    const store = createPrivateFileStore(fileBackend, { idFactory: idFactory() });

    await expect(store.completeUpload(workspaceId, attachmentId)).rejects.toBeInstanceOf(ParentNotFoundError);
    expect(fileBackend.parentExists).toHaveBeenCalledWith(workspaceId, { type: 'task', id: quarantine.taskId });
    expect(fileBackend.deleteQuarantine).toHaveBeenCalledWith(workspaceId, attachmentId, quarantine.storagePath);
    expect(fileBackend.downloadObject).not.toHaveBeenCalled();
    expect(fileBackend.uploadReadyObject).not.toHaveBeenCalled();
  });

  it('discards invalid uploaded bytes and leaves a failed cleanup discoverable without leaking its path', async () => {
    const invalidBytes = Buffer.from('<html>secret</html>');
    const deleteQuarantine = vi.fn().mockRejectedValue(new Error('storage unavailable at private/key'));
    const fileBackend = backend({
      getAttachment: vi.fn().mockResolvedValue({ ...quarantine, size: invalidBytes.length }),
      downloadObject: vi.fn().mockResolvedValue(invalidBytes),
      deleteQuarantine,
    });
    const store = createPrivateFileStore(fileBackend, { idFactory: idFactory() });

    await expect(store.completeUpload(workspaceId, attachmentId)).rejects.toThrow(/HTML|TXT/iu);
    expect(deleteQuarantine).toHaveBeenCalledWith(workspaceId, attachmentId, quarantine.storagePath);
    expect(fileBackend.expireQuarantine).toHaveBeenCalledWith(workspaceId, attachmentId);
  });

  it('never signs a download unless the row is ready and always uses exactly 60 seconds', async () => {
    const fileBackend = backend();
    const store = createPrivateFileStore(fileBackend);
    await expect(store.signDownload(workspaceId, attachmentId, 60)).rejects.toBeInstanceOf(FileNotReadyError);
    expect(fileBackend.createSignedDownloadUrl).not.toHaveBeenCalled();

    vi.mocked(fileBackend.getAttachment).mockResolvedValueOnce({
      ...quarantine,
      state: 'ready',
      storagePath: attachmentId,
      sha256: 'a'.repeat(64),
      quarantineExpiresAt: null,
      completedAt: '2026-08-02T12:00:00.000Z',
    });
    const signed = await store.signDownload(workspaceId, attachmentId, 60);
    expect(fileBackend.createSignedDownloadUrl).toHaveBeenCalledWith(attachmentId, 60, 'policy.txt');
    expect(signed).toMatchObject({ expiresIn: 60, name: 'policy.txt', mimeType: 'text/plain' });
  });

  it('denies a ready download when its parent was deleted after completion', async () => {
    const ready = {
      ...quarantine,
      state: 'ready' as const,
      storagePath: attachmentId,
      sha256: 'a'.repeat(64),
      quarantineExpiresAt: null,
      completedAt: '2026-08-02T12:00:00.000Z',
    };
    const fileBackend = backend({
      getAttachment: vi.fn().mockResolvedValue(ready),
      parentExists: vi.fn().mockResolvedValue(false),
    });
    const store = createPrivateFileStore(fileBackend);

    await expect(store.signDownload(workspaceId, attachmentId, 60)).rejects.toBeInstanceOf(FileNotFoundError);
    expect(fileBackend.parentExists).toHaveBeenCalledWith(workspaceId, { type: 'task', id: quarantine.taskId });
    expect(fileBackend.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects completion after quarantine expiry and removes expired rows plus queued orphan objects', async () => {
    const expired = { ...quarantine, quarantineExpiresAt: '2026-08-02T11:59:59.000Z' };
    const fileBackend = backend({
      getAttachment: vi.fn().mockResolvedValue(expired),
      listExpiredQuarantines: vi.fn().mockResolvedValue([expired]),
      listQueuedObjects: vi.fn().mockResolvedValue([{ id: 'queue-1', workspaceId, storagePath: quarantineObjectId }]),
    });
    const store = createPrivateFileStore(fileBackend, { clock: () => new Date('2026-08-02T12:00:00.000Z') });

    await expect(store.completeUpload(workspaceId, attachmentId)).rejects.toBeInstanceOf(UploadExpiredError);
    const cleanup = await store.cleanupExpiredUploads(new Date('2026-08-02T12:00:00.000Z'), 20);
    expect(fileBackend.deleteQuarantine).toHaveBeenCalledWith(workspaceId, attachmentId, quarantine.storagePath);
    expect(fileBackend.removeObject).toHaveBeenCalledWith(quarantineObjectId);
    expect(fileBackend.finishQueuedObjectRemoval).toHaveBeenCalledWith('queue-1', cleanupLeaseId);
    expect(cleanup).toEqual({ removed: 2, failed: 0 });
  });

  it('never removes a queued object unless the backend authoritatively releases it for deletion', async () => {
    const liveReady = {
      ...quarantine,
      state: 'ready' as const,
      storagePath: attachmentId,
      sha256: 'a'.repeat(64),
      quarantineExpiresAt: null,
      completedAt: '2026-08-02T12:00:00.000Z',
    };
    const fileBackend = backend({
      getAttachment: vi.fn().mockResolvedValue(liveReady),
      listQueuedObjects: vi.fn().mockResolvedValue([{ id: 'queue-live', workspaceId, storagePath: attachmentId }]),
      prepareQueuedObjectRemoval: vi.fn().mockResolvedValue(null),
    } as Partial<FileBackend>);
    const store = createPrivateFileStore(fileBackend);

    const cleanup = await store.cleanupExpiredUploads(new Date('2026-08-02T12:00:00.000Z'), 20);

    expect((fileBackend as FileBackend & { prepareQueuedObjectRemoval: ReturnType<typeof vi.fn> }).prepareQueuedObjectRemoval)
      .toHaveBeenCalledWith('queue-live');
    expect(fileBackend.removeObject).not.toHaveBeenCalledWith(attachmentId);
    expect(fileBackend.finishQueuedObjectRemoval).not.toHaveBeenCalled();
    expect(cleanup).toEqual({ removed: 0, failed: 0 });
  });
});
