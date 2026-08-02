import { ConflictError, type WorkspaceListener } from '@/data/workspace-repository';
import { validateUpload, type AttachmentTarget, type SignedAttachmentDownload } from '@/domain/files';
import type { CommentInput, ContactInput, ContactPatchInput, KnowledgeInput, KnowledgePatchInput, SecureItemInput, SecureItemPatchInput, TaskInput, TaskPatchInput } from '@/domain/schemas';
import type { WorkspaceGateway } from '@/data/workspace-gateway';
import type { Attachment, Comment, Contact, KnowledgeItem, SearchResult, SecureItemReveal, SecureItemSummary, Task, WorkspaceSnapshot } from '@/domain/types';

type ApiEnvelope<T> = { data: T | null; error: { code: string; message: string } | null; requestId: string };
type RealtimeSubscriber = (workspaceId: string, listener: () => void) => () => void;

type ApiRepositoryOptions = {
  initialSnapshot: WorkspaceSnapshot;
  fetcher?: typeof fetch;
  realtime: RealtimeSubscriber;
  signal?: AbortSignal;
};

function clone<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T;
}

function mergeSnapshot(current: WorkspaceSnapshot, incoming: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  if (incoming.workspaceId !== undefined && incoming.workspaceId !== current.workspaceId) {
    throw new Error('Сервер вернул данные другого рабочего пространства.');
  }
  return {
    ...current,
    ...incoming,
    taskStatuses: incoming.taskStatuses ?? current.taskStatuses,
    sections: incoming.sections ?? current.sections,
    tasks: incoming.tasks ?? current.tasks,
    comments: incoming.comments ?? current.comments,
    knowledge: incoming.knowledge ?? current.knowledge,
    contacts: incoming.contacts ?? current.contacts,
    members: incoming.members ?? current.members,
    secureItems: incoming.secureItems ?? current.secureItems,
    auditEvents: incoming.auditEvents ?? current.auditEvents,
    notificationDeliveries: incoming.notificationDeliveries ?? current.notificationDeliveries,
  };
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createApiRepository(options: ApiRepositoryOptions): WorkspaceGateway & { pendingTaskInput(id: string): TaskPatchInput | undefined } {
  const fetcher = options.fetcher ?? fetch;
  let state = clone(options.initialSnapshot);
  const listeners = new Set<WorkspaceListener>();
  const pendingTasks = new Map<string, TaskPatchInput>();
  let disposed = false;
  let hydrated = false;
  let hydration: Promise<void> | null = null;

  const assertActive = () => {
    if (disposed || options.signal?.aborted) throw new DOMException('Workspace request aborted.', 'AbortError');
  };

  const notify = () => {
    const snapshot = clone(state);
    for (const listener of listeners) listener(snapshot);
  };

  const hydrate = async (force = false) => {
    if (hydrated && !force) return;
    if (hydration) return hydration;
    hydration = (async () => {
      assertActive();
      const response = await fetcher('/api/tasks', {
        credentials: 'same-origin', headers: { accept: 'application/json' },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      assertActive();
      const result = await envelope<WorkspaceSnapshot>(response);
      assertActive();
      if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'Не удалось загрузить задачи.');
      state = mergeSnapshot(state, result.data);
      hydrated = true;
      notify();
    })().finally(() => { hydration = null; });
    return hydration;
  };

  const unsubscribeRealtime = options.realtime(state.workspaceId, () => {
    if (!disposed) void hydrate(true).catch(() => { /* Keep the last known safe snapshot and retry on the next event. */ });
  });

  const request = async <T>(url: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    assertActive();
    const response = await fetcher(url, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ?? options.signal ? { signal: signal ?? options.signal } : {}),
    });
    assertActive();
    const result = await envelope<T>(response);
    assertActive();
    if (response.status === 409 && result.data && typeof result.data === 'object') {
      const versions = result.data as { expectedVersion?: unknown; actualVersion?: unknown };
      if (typeof versions.expectedVersion === 'number' && typeof versions.actualVersion === 'number') throw new ConflictError(versions.expectedVersion, versions.actualVersion);
    }
    if (!response.ok || !result.data) throw new Error(result.error?.message ?? 'Не удалось выполнить запрос.');
    return result.data;
  };

  return {
    fileStorageMode: 'persistent',
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
    async createKnowledge(input: KnowledgeInput): Promise<KnowledgeItem> {
      const created = await request<KnowledgeItem>('/api/knowledge', 'POST', input);
      state.knowledge.push(created);
      notify();
      return clone(created);
    },
    async updateKnowledge(id: string, input: KnowledgePatchInput, expectedVersion: number): Promise<KnowledgeItem> {
      const updated = await request<KnowledgeItem>(`/api/knowledge/${encodeURIComponent(id)}`, 'PATCH', { input, expectedVersion });
      state.knowledge = state.knowledge.map((item) => item.id === id ? updated : item);
      notify();
      return clone(updated);
    },
    async deleteKnowledge(id: string, expectedVersion: number): Promise<KnowledgeItem> {
      const deleted = await request<KnowledgeItem>(`/api/knowledge/${encodeURIComponent(id)}`, 'DELETE', { expectedVersion });
      state.knowledge = state.knowledge.filter((item) => item.id !== id);
      notify();
      return clone(deleted);
    },
    async restoreKnowledge(id: string, expectedVersion: number): Promise<KnowledgeItem> {
      const restored = await request<KnowledgeItem>(`/api/knowledge/${encodeURIComponent(id)}`, 'PATCH', { action: 'restore', expectedVersion });
      state.knowledge.push(restored);
      notify();
      return clone(restored);
    },
    async createContact(input: ContactInput): Promise<Contact> {
      const created = await request<Contact>('/api/contacts', 'POST', input);
      state.contacts.push(created);
      notify();
      return clone(created);
    },
    async updateContact(id: string, input: ContactPatchInput, expectedVersion: number): Promise<Contact> {
      const updated = await request<Contact>(`/api/contacts/${encodeURIComponent(id)}`, 'PATCH', { input, expectedVersion });
      state.contacts = state.contacts.map((item) => item.id === id ? updated : item);
      notify();
      return clone(updated);
    },
    async deleteContact(id: string, expectedVersion: number): Promise<Contact> {
      const deleted = await request<Contact>(`/api/contacts/${encodeURIComponent(id)}`, 'DELETE', { expectedVersion });
      state.contacts = state.contacts.filter((item) => item.id !== id);
      notify();
      return clone(deleted);
    },
    async restoreContact(id: string, expectedVersion: number): Promise<Contact> {
      const restored = await request<Contact>(`/api/contacts/${encodeURIComponent(id)}`, 'PATCH', { action: 'restore', expectedVersion });
      state.contacts.push(restored);
      notify();
      return clone(restored);
    },
    async createSecureItem(input: SecureItemInput): Promise<SecureItemSummary> {
      const created = await request<SecureItemSummary>('/api/secure-items', 'POST', input);
      state.secureItems.push(created);
      notify();
      return clone(created);
    },
    async updateSecureItem(id: string, input: SecureItemPatchInput, expectedVersion: number): Promise<SecureItemSummary> {
      const updated = await request<SecureItemSummary>(`/api/secure-items/${encodeURIComponent(id)}`, 'PATCH', { input, expectedVersion });
      state.secureItems = state.secureItems.map((item) => item.id === id ? updated : item);
      notify();
      return clone(updated);
    },
    async deleteSecureItem(id: string, expectedVersion: number): Promise<SecureItemSummary> {
      const deleted = await request<SecureItemSummary>(`/api/secure-items/${encodeURIComponent(id)}`, 'DELETE', { expectedVersion });
      state.secureItems = state.secureItems.filter((item) => item.id !== id);
      notify();
      return clone(deleted);
    },
    async restoreSecureItem(id: string, expectedVersion: number): Promise<SecureItemSummary> {
      const restored = await request<SecureItemSummary>(`/api/secure-items/${encodeURIComponent(id)}`, 'PATCH', {
        action: 'restore', expectedVersion,
      });
      state.secureItems = [...state.secureItems.filter((item) => item.id !== id), restored];
      notify();
      return clone(restored);
    },
    async revealSecureItem(id: string): Promise<SecureItemReveal> {
      return request<SecureItemReveal>(`/api/secure-items/${encodeURIComponent(id)}/reveal`, 'POST', {});
    },
    async uploadAttachment(target: AttachmentTarget, file: File, onProgress?: (percent: number) => void): Promise<Attachment> {
      assertActive();
      onProgress?.(10);
      const headerBytes = new Uint8Array(await file.slice(0, 8_192).arrayBuffer());
      const validated = validateUpload({ name: file.name, declaredMime: file.type, size: file.size, headerBytes });
      const signed = await request<Attachment & { uploadUrl: string; expiresAt: string }>('/api/files/sign-upload', 'POST', {
        parentType: target.type,
        parentId: target.id,
        name: validated.name,
        declaredMime: validated.declaredMime,
        size: validated.size,
        headerBase64: bytesToBase64(headerBytes),
      });
      onProgress?.(30);
      const uploadResponse = await fetcher(signed.uploadUrl, {
        method: 'PUT',
        credentials: 'omit',
        headers: {
          'cache-control': 'max-age=0',
          'content-type': file.type,
          'x-upsert': 'false',
        },
        body: file,
        referrerPolicy: 'no-referrer',
        ...(options.signal ? { signal: options.signal } : {}),
      });
      assertActive();
      if (!uploadResponse.ok) throw new Error('Не удалось передать файл в закрытое хранилище.');
      onProgress?.(80);
      const completed = await request<Attachment>(`/api/files/${encodeURIComponent(signed.id)}/complete`, 'POST', {});
      if (target.type === 'task') {
        state.tasks = state.tasks.map((item) => item.id === target.id ? {
          ...item,
          attachments: [...item.attachments.filter((attachment) => attachment.id !== completed.id), completed],
        } : item);
      } else {
        state.knowledge = state.knowledge.map((item) => item.id === target.id ? {
          ...item,
          attachments: [...item.attachments.filter((attachment) => attachment.id !== completed.id), completed],
        } : item);
      }
      onProgress?.(100);
      notify();
      return clone(completed);
    },
    async downloadAttachment(id: string): Promise<SignedAttachmentDownload> {
      return { url: `/api/files/${encodeURIComponent(id)}/download` };
    },
    async search(query: string, options?: { signal?: AbortSignal }): Promise<SearchResult[]> {
      return query.trim() ? request<SearchResult[]>('/api/search', 'POST', { query }, options?.signal) : [];
    },
    pendingTaskInput: (id: string) => {
      const input = pendingTasks.get(id);
      return input ? clone(input) : undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeRealtime();
      listeners.clear();
    },
  };
}
