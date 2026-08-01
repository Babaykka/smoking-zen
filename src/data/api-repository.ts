import { ConflictError, type WorkspaceListener } from '@/data/workspace-repository';
import type { CommentInput, TaskInput, TaskPatchInput } from '@/domain/schemas';
import type { WorkspaceGateway } from '@/data/workspace-gateway';
import type { Comment, Task, WorkspaceSnapshot } from '@/domain/types';

type ApiEnvelope<T> = { data: T | null; error: { code: string; message: string } | null; requestId: string };
type RealtimeSubscriber = (workspaceId: string, listener: () => void) => () => void;

type ApiRepositoryOptions = {
  initialSnapshot: WorkspaceSnapshot;
  fetcher?: typeof fetch;
  realtime: RealtimeSubscriber;
};

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T;
}

async function envelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error('Сервер вернул некорректный ответ.');
  }
  if (!parsed || typeof parsed !== 'object' || !('data' in parsed) || !('error' in parsed)) throw new Error('Сервер вернул некорректный ответ.');
  return parsed as ApiEnvelope<T>;
}

export function createApiRepository(options: ApiRepositoryOptions): WorkspaceGateway & { pendingTaskInput(id: string): TaskPatchInput | undefined } {
  const fetcher = options.fetcher ?? fetch;
  let state = clone(options.initialSnapshot);
  const listeners = new Set<WorkspaceListener>();
  const pendingTasks = new Map<string, TaskPatchInput>();
  let disposed = false;
  let hydrated = false;
  let hydration: Promise<void> | null = null;

  const notify = () => {
    const snapshot = clone(state);
    for (const listener of listeners) listener(snapshot);
  };

  const hydrate = async (force = false) => {
    if (hydrated && !force) return;
    if (hydration) return hydration;
    hydration = (async () => {
      const response = await fetcher('/api/tasks', { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const result = await envelope<WorkspaceSnapshot>(response);
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'Не удалось загрузить задачи.');
      state = clone(result.data);
      hydrated = true;
      notify();
    })().finally(() => { hydration = null; });
    return hydration;
  };

  const unsubscribeRealtime = options.realtime(state.workspaceId, () => {
    if (!disposed) void hydrate(true).catch(() => { /* Keep the last known safe snapshot and retry on the next event. */ });
  });

  const request = async <T>(url: string, method: string, body: unknown): Promise<T> => {
    const response = await fetcher(url, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await envelope<T>(response);
    if (response.status === 409 && result.data && typeof result.data === 'object') {
      const versions = result.data as { expectedVersion?: unknown; actualVersion?: unknown };
      if (typeof versions.expectedVersion === 'number' && typeof versions.actualVersion === 'number') throw new ConflictError(versions.expectedVersion, versions.actualVersion);
    }
    if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'Не удалось выполнить запрос.');
    return result.data;
  };

  return {
    snapshot: () => clone(state),
    hydrate,
    subscribe(listener: WorkspaceListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async createTask(input: TaskInput): Promise<Task> {
      const created = await request<Task>('/api/tasks', 'POST', input);
      state.tasks.push(created);
      notify();
      return clone(created);
    },
    async updateTask(id: string, input: TaskPatchInput, expectedVersion: number): Promise<Task> {
      pendingTasks.set(id, clone(input));
      try {
        const updated = await request<Task>(`/api/tasks/${encodeURIComponent(id)}`, 'PATCH', { input, expectedVersion });
        state.tasks = state.tasks.map((task) => task.id === id ? updated : task);
        pendingTasks.delete(id);
        notify();
        return clone(updated);
      } catch (error) {
        if (!(error instanceof ConflictError)) pendingTasks.delete(id);
        throw error;
      }
    },
    async deleteTask(id: string, expectedVersion: number): Promise<Task> {
      const deleted = await request<Task>(`/api/tasks/${encodeURIComponent(id)}`, 'DELETE', { expectedVersion });
      state.tasks = state.tasks.filter((task) => task.id !== id);
      notify();
      return clone(deleted);
    },
    async restoreTask(id: string, expectedVersion: number): Promise<Task> {
      const restored = await request<Task>(`/api/tasks/${encodeURIComponent(id)}`, 'PATCH', { action: 'restore', expectedVersion });
      state.tasks.push(restored);
      notify();
      return clone(restored);
    },
    async createComment(input: CommentInput): Promise<Comment> {
      const created = await request<Comment>('/api/comments', 'POST', input);
      state.comments.push(created);
      notify();
      return clone(created);
    },
    pendingTaskInput: (id: string) => {
      const input = pendingTasks.get(id);
      return input ? clone(input) : undefined;
    },
    dispose() {
      disposed = true;
      unsubscribeRealtime();
      listeners.clear();
    },
  };
}
