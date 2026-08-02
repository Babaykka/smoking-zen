import type {
  Comment,
  Contact,
  KnowledgeItem,
  SearchResult,
  SecureItemReveal,
  SecureItemSummary,
  Task,
  WorkspaceEntity,
  WorkspaceSnapshot,
} from '@/domain/types';
import type {
  CommentInput,
  ContactInput,
  ContactPatchInput,
  KnowledgeInput,
  KnowledgePatchInput,
  SecureItemInput,
  SecureItemPatchInput,
  TaskInput,
} from '@/domain/schemas';

export type RestorableRecord = Task | Comment | KnowledgeItem | Contact | SecureItemSummary;
export type WorkspaceListener = (snapshot: WorkspaceSnapshot) => void;

export type WorkspacePersistence = {
  load(): unknown;
  save(state: WorkspaceSnapshot): void;
};

export class ConflictError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super('Запись была изменена другим пользователем. Обновите данные и повторите попытку.');
    this.name = 'ConflictError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class RestoreNotFoundError extends Error {
  constructor() {
    super('Запись для восстановления не найдена.');
    this.name = 'RestoreNotFoundError';
  }
}

export class RestoreNotDeletedError extends Error {
  constructor() {
    super('Запись не удалена и не требует восстановления.');
    this.name = 'RestoreNotDeletedError';
  }
}

export class RestoreExpiredError extends Error {
  constructor() {
    super('Восстановление доступно только 30 дней после удаления.');
    this.name = 'RestoreExpiredError';
  }
}

const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export function assertRestorableRecord(
  record: { version: number; deletedAt: string | null } | null | undefined,
  expectedVersion: number,
  currentTime = Date.now(),
): asserts record is { version: number; deletedAt: string } {
  if (!record) throw new RestoreNotFoundError();
  if (record.version !== expectedVersion) throw new ConflictError(expectedVersion, record.version);
  if (record.deletedAt === null) throw new RestoreNotDeletedError();
  const deletedAt = Date.parse(record.deletedAt);
  if (!Number.isFinite(deletedAt) || currentTime >= deletedAt + RESTORE_WINDOW_MS) {
    throw new RestoreExpiredError();
  }
}

export interface WorkspaceRepository {
  snapshot(): WorkspaceSnapshot;
  createTask(input: TaskInput): Task;
  updateTask(id: string, input: Partial<TaskInput>, expectedVersion: number): Task;
  deleteTask(id: string, expectedVersion: number): Task;
  createComment(input: CommentInput): Comment;
  updateComment(id: string, input: Partial<CommentInput>, expectedVersion: number): Comment;
  deleteComment(id: string, expectedVersion: number): Comment;
  createKnowledge(input: KnowledgeInput): KnowledgeItem;
  updateKnowledge(id: string, input: KnowledgePatchInput, expectedVersion: number): KnowledgeItem;
  deleteKnowledge(id: string, expectedVersion: number): KnowledgeItem;
  createContact(input: ContactInput): Contact;
  updateContact(id: string, input: ContactPatchInput, expectedVersion: number): Contact;
  deleteContact(id: string, expectedVersion: number): Contact;
  createSecureItem(input: SecureItemInput): SecureItemSummary;
  updateSecureItem(id: string, input: SecureItemPatchInput, expectedVersion: number): SecureItemSummary;
  deleteSecureItem(id: string, expectedVersion: number): SecureItemSummary;
  revealSecureItem(id: string): SecureItemReveal;
  restore(entity: WorkspaceEntity, id: string, expectedVersion: number): RestorableRecord;
  hydrate(): void;
  search(query: string): SearchResult[];
  subscribe(listener: WorkspaceListener): () => void;
}
