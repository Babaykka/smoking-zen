import type { WorkspaceRepository, WorkspaceListener } from '@/data/workspace-repository';
import type { CommentInput, ContactInput, ContactPatchInput, KnowledgeInput, KnowledgePatchInput, TaskInput, TaskPatchInput } from '@/domain/schemas';
import type { Comment, Contact, KnowledgeItem, SearchResult, Task, WorkspaceSnapshot } from '@/domain/types';

export interface WorkspaceGateway {
  snapshot(): WorkspaceSnapshot;
  hydrate(): Promise<void>;
  subscribe(listener: WorkspaceListener): () => void;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(id: string, input: TaskPatchInput, expectedVersion: number): Promise<Task>;
  deleteTask(id: string, expectedVersion: number): Promise<Task>;
  restoreTask(id: string, expectedVersion: number): Promise<Task>;
  createComment(input: CommentInput): Promise<Comment>;
  createKnowledge(input: KnowledgeInput): Promise<KnowledgeItem>;
  updateKnowledge(id: string, input: KnowledgePatchInput, expectedVersion: number): Promise<KnowledgeItem>;
  deleteKnowledge(id: string, expectedVersion: number): Promise<KnowledgeItem>;
  restoreKnowledge(id: string, expectedVersion: number): Promise<KnowledgeItem>;
  createContact(input: ContactInput): Promise<Contact>;
  updateContact(id: string, input: ContactPatchInput, expectedVersion: number): Promise<Contact>;
  deleteContact(id: string, expectedVersion: number): Promise<Contact>;
  restoreContact(id: string, expectedVersion: number): Promise<Contact>;
  search(query: string, options?: { signal?: AbortSignal }): Promise<SearchResult[]>;
  dispose?(): void;
}

export function createDemoGateway(repository: WorkspaceRepository): WorkspaceGateway {
  return {
    snapshot: () => repository.snapshot(),
    async hydrate() { repository.hydrate(); },
    subscribe: (listener) => repository.subscribe(listener),
    async createTask(input) { return repository.createTask(input); },
    async updateTask(id, input, expectedVersion) { return repository.updateTask(id, input, expectedVersion); },
    async deleteTask(id, expectedVersion) { return repository.deleteTask(id, expectedVersion); },
    async restoreTask(id, expectedVersion) { return repository.restore('task', id, expectedVersion) as Task; },
    async createComment(input) { return repository.createComment(input); },
    async createKnowledge(input) { return repository.createKnowledge(input); },
    async updateKnowledge(id, input, expectedVersion) { return repository.updateKnowledge(id, input, expectedVersion); },
    async deleteKnowledge(id, expectedVersion) { return repository.deleteKnowledge(id, expectedVersion); },
    async restoreKnowledge(id, expectedVersion) { return repository.restore('knowledge', id, expectedVersion) as KnowledgeItem; },
    async createContact(input) { return repository.createContact(input); },
    async updateContact(id, input, expectedVersion) { return repository.updateContact(id, input, expectedVersion); },
    async deleteContact(id, expectedVersion) { return repository.deleteContact(id, expectedVersion); },
    async restoreContact(id, expectedVersion) { return repository.restore('contact', id, expectedVersion) as Contact; },
    async search(query) { return repository.search(query); },
  };
}
