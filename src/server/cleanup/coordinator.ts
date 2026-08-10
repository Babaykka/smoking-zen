export type FileCleanupCandidate = {
  id: string;
  workspaceId: string;
  storagePath: string;
};

export type OrphanCleanupCandidate = { storagePath: string };
export type CleanupFailureCode = 'storage_unavailable';

export interface CleanupBackend {
  stageFileCleanup(): Promise<number>;
  listFileCleanup(): Promise<FileCleanupCandidate[]>;
  prepareFileCleanup(id: string): Promise<string | null>;
  removeObject(storagePath: string): Promise<void>;
  finishFileCleanup(id: string, leaseId: string): Promise<boolean>;
  failFileCleanup(id: string, leaseId: string, code: CleanupFailureCode): Promise<boolean>;
  discoverOrphans(): Promise<number>;
  listOrphans(): Promise<OrphanCleanupCandidate[]>;
  prepareOrphan(storagePath: string): Promise<string | null>;
  finishOrphan(storagePath: string, leaseId: string): Promise<boolean>;
  failOrphan(storagePath: string, leaseId: string, code: CleanupFailureCode): Promise<boolean>;
  purgeDeletedRecords(): Promise<number>;
}

export type CleanupCycleResult = {
  staged: number;
  fileCandidates: number;
  fileRemoved: number;
  orphanDiscovered: number;
  orphanCandidates: number;
  orphanRemoved: number;
  pending: number;
  failed: number;
  purged: number;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_PATTERN = new RegExp(`^${UUID}$`);

function validFilePath(candidate: FileCleanupCandidate): boolean {
  if (!UUID_PATTERN.test(candidate.id) || !UUID_PATTERN.test(candidate.workspaceId)) return false;
  if (UUID_PATTERN.test(candidate.storagePath)) return true;
  return new RegExp(`^${candidate.workspaceId}/(?:quarantine|ready)/${UUID}$`).test(candidate.storagePath);
}

function missing(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === 'storage_not_found';
}

export async function runCleanupCycle(backend: CleanupBackend): Promise<CleanupCycleResult> {
  const result: CleanupCycleResult = {
    staged: 0,
    fileCandidates: 0,
    fileRemoved: 0,
    orphanDiscovered: 0,
    orphanCandidates: 0,
    orphanRemoved: 0,
    pending: 0,
    failed: 0,
    purged: 0,
  };

  result.staged = await backend.stageFileCleanup();
  const files = await backend.listFileCleanup();
  result.fileCandidates = files.length;
  for (const candidate of files) {
    if (!validFilePath(candidate)) {
      result.failed += 1;
      continue;
    }
    let lease: string | null = null;
    try {
      lease = await backend.prepareFileCleanup(candidate.id);
      if (!lease) continue;
      try {
        await backend.removeObject(candidate.storagePath);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (await backend.finishFileCleanup(candidate.id, lease)) result.fileRemoved += 1;
      else result.pending += 1;
    } catch {
      result.failed += 1;
      if (lease) {
        try {
          if (!await backend.failFileCleanup(candidate.id, lease, 'storage_unavailable')) {
            result.pending += 1;
          }
        } catch {
          result.pending += 1;
        }
      }
    }
  }

  result.orphanDiscovered = await backend.discoverOrphans();
  const orphans = await backend.listOrphans();
  result.orphanCandidates = orphans.length;
  for (const candidate of orphans) {
    if (!UUID_PATTERN.test(candidate.storagePath)) {
      result.failed += 1;
      continue;
    }
    let lease: string | null = null;
    try {
      lease = await backend.prepareOrphan(candidate.storagePath);
      if (!lease) continue;
      try {
        await backend.removeObject(candidate.storagePath);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (await backend.finishOrphan(candidate.storagePath, lease)) result.orphanRemoved += 1;
      else result.pending += 1;
    } catch {
      result.failed += 1;
      if (lease) {
        try {
          if (!await backend.failOrphan(candidate.storagePath, lease, 'storage_unavailable')) {
            result.pending += 1;
          }
        } catch {
          result.pending += 1;
        }
      }
    }
  }

  result.purged += await backend.purgeDeletedRecords();
  result.purged += await backend.purgeDeletedRecords();
  return result;
}
