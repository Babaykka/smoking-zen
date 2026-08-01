import type { WorkspaceRepository, WorkspaceListener } from '@/data/workspace-repository';
import type { CommentInput, TaskInput, TaskPatchInput } from '@/domain/schemas';
import type { Comment, Task, WorkspaceSnapshot } from '@/domain/types';

export interface WorkspaceGateway {
  snapshot(): WorkspaceSnapshot;
  hydrate(): Promise<void>;
  subscribe(listener: WorkspaceListener): () => void;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(id: string, input: TaskPatchInput, expectedVersion: number): Promise<Task>;
  deleteTask(id: string, expectedVersion: number): Promise<Task>;
  restoreTask(id: string, expectedVersion: number): Promise<Task>;
  createComment(input: CommentInput): Promise<Comment>;
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
  };
}
