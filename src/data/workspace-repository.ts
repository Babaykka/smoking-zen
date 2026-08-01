import type {
  Comment,
  Contact,
  KnowledgeItem,
  SearchResult,
  SecureItemLink,
  Task,
  WorkspaceEntity,
  WorkspaceSnapshot,
} from '@/domain/types';
import type {
  CommentInput,
  ContactInput,
  KnowledgeInput,
  SecureItemInput,
  TaskInput,
} from '@/domain/schemas';

export type RestorableRecord = Task | Comment | KnowledgeItem | Contact | SecureItemLink;
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

export interface WorkspaceRepository {
  snapshot(): WorkspaceSnapshot;
  createTask(input: TaskInput): Task;
  updateTask(id: string, input: Partial<TaskInput>, expectedVersion: number): Task;
  deleteTask(id: string, expectedVersion: number): Task;
  createComment(input: CommentInput): Comment;
  updateComment(id: string, input: Partial<CommentInput>, expectedVersion: number): Comment;
  deleteComment(id: string, expectedVersion: number): Comment;
  createKnowledge(input: KnowledgeInput): KnowledgeItem;
  updateKnowledge(id: string, input: Partial<KnowledgeInput>, expectedVersion: number): KnowledgeItem;
  deleteKnowledge(id: string, expectedVersion: number): KnowledgeItem;
  createContact(input: ContactInput): Contact;
  updateContact(id: string, input: Partial<ContactInput>, expectedVersion: number): Contact;
  deleteContact(id: string, expectedVersion: number): Contact;
  createSecureItem(input: SecureItemInput): SecureItemLink;
  updateSecureItem(id: string, input: Partial<SecureItemInput>, expectedVersion: number): SecureItemLink;
  deleteSecureItem(id: string, expectedVersion: number): SecureItemLink;
  restore(entity: WorkspaceEntity, id: string, expectedVersion: number): RestorableRecord;
  search(query: string): SearchResult[];
  subscribe(listener: WorkspaceListener): () => void;
}
