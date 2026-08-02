import {
  commentInputSchema,
  contactInputSchema,
  knowledgeInputSchema,
  mergeKnowledgePatch,
  secureItemInputSchema,
  taskInputSchema,
  type CommentInput,
  type ContactInput,
  type KnowledgeInput,
  type SecureItemInput,
  type TaskInput,
} from '@/domain/schemas';
import { searchWorkspace } from '@/domain/search';
import type {
  AuditAction,
  Comment,
  Contact,
  KnowledgeItem,
  RecordMetadata,
  SecureItemLink,
  Task,
  WorkspaceEntity,
  WorkspaceSnapshot,
} from '@/domain/types';
import { demoSeed } from '@/data/demo-seed';
import {
  assertRestorableRecord,
  ConflictError,
  type RestorableRecord,
  type WorkspaceListener,
  type WorkspacePersistence,
  type WorkspaceRepository,
} from '@/data/workspace-repository';

type RepositoryOptions = {
  persistence?: WorkspacePersistence;
  clock?: () => string;
  idFactory?: () => string;
  seed?: WorkspaceSnapshot;
  loadPersisted?: boolean;
};

type MutableRecord = Task | Comment | KnowledgeItem | Contact | SecureItemLink;

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkspaceSnapshot>;
  return typeof candidate.workspaceId === 'string' &&
    Array.isArray(candidate.taskStatuses) && Array.isArray(candidate.sections) && Array.isArray(candidate.tasks) &&
    Array.isArray(candidate.comments) && Array.isArray(candidate.knowledge) && Array.isArray(candidate.contacts) &&
    Array.isArray(candidate.members) && Array.isArray(candidate.secureItems) && Array.isArray(candidate.auditEvents) &&
    Array.isArray(candidate.notificationDeliveries);
}

function visibleSnapshot(state: WorkspaceSnapshot): WorkspaceSnapshot {
  const active = <T extends RecordMetadata>(records: T[]) => records.filter((record) => record.deletedAt === null);
  const snapshot = clone(state);
  snapshot.taskStatuses = active(snapshot.taskStatuses);
  snapshot.sections = active(snapshot.sections);
  snapshot.tasks = active(snapshot.tasks);
  snapshot.comments = active(snapshot.comments);
  snapshot.knowledge = active(snapshot.knowledge);
  snapshot.contacts = active(snapshot.contacts);
  snapshot.members = active(snapshot.members);
  snapshot.secureItems = active(snapshot.secureItems);
  snapshot.notificationDeliveries = active(snapshot.notificationDeliveries);
  return snapshot;
}

export function createLocalStoragePersistence(key = 'smoking-zen-demo-workspace'): WorkspacePersistence {
  return {
    load() {
      if (typeof window === 'undefined') return null;
      try {
        const stored = window.localStorage.getItem(key);
        return stored ? JSON.parse(stored) : null;
      } catch {
        return null;
      }
    },
    save(state) {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, JSON.stringify(state));
      } catch {
        // Demo mode remains usable when browser storage is unavailable.
      }
    },
  };
}

export function createDemoRepository(options: RepositoryOptions = {}): WorkspaceRepository {
  const persistence = options.persistence ?? createLocalStoragePersistence();
  const loadPersisted = options.loadPersisted ?? options.persistence !== undefined;
  const loaded = loadPersisted ? persistence.load() : null;
  let state = isSnapshot(loaded) ? clone(loaded) : clone(options.seed ?? demoSeed);
  const listeners = new Set<WorkspaceListener>();
  const now = options.clock ?? (() => new Date().toISOString());
  const existingIds = new Set<string>();
  let generatedIds = 0;
  const initializeGeneratedIds = () => {
    existingIds.clear();
    generatedIds = 0;
    for (const record of [
      ...state.taskStatuses,
      ...state.sections,
      ...state.tasks,
      ...state.comments,
      ...state.knowledge,
      ...state.contacts,
      ...state.members,
      ...state.secureItems,
      ...state.auditEvents,
      ...state.notificationDeliveries,
    ]) {
      existingIds.add(record.id);
      const match = /^demo-(\d+)$/.exec(record.id);
      if (match) generatedIds = Math.max(generatedIds, Number(match[1]));
    }
  };
  initializeGeneratedIds();
  const nextId = options.idFactory ?? (() => {
    let candidate = `demo-${++generatedIds}`;
    while (existingIds.has(candidate)) candidate = `demo-${++generatedIds}`;
    existingIds.add(candidate);
    return candidate;
  });

  const recordCollections: Record<WorkspaceEntity, keyof Pick<WorkspaceSnapshot, 'tasks' | 'comments' | 'knowledge' | 'contacts' | 'secureItems'>> = {
    task: 'tasks', comment: 'comments', knowledge: 'knowledge', contact: 'contacts', secureItem: 'secureItems',
  };

  const recordsFor = (entity: WorkspaceEntity): MutableRecord[] => state[recordCollections[entity]] as MutableRecord[];

  const findActive = (entity: WorkspaceEntity, id: string): MutableRecord => {
    const record = recordsFor(entity).find((candidate) => candidate.id === id && candidate.deletedAt === null);
    if (!record) throw new Error('Запись не найдена');
    return record;
  };

  const notify = () => {
    for (const listener of listeners) listener(visibleSnapshot(state));
  };

  const persistAndNotify = () => {
    persistence.save(clone(state));
    notify();
  };

  const audit = (entity: WorkspaceEntity, entityId: string, action: AuditAction) => {
    state.auditEvents.push({ id: nextId(), workspaceId: state.workspaceId, entity, entityId, action, occurredAt: now() });
  };

  const assertVersion = (record: MutableRecord, expectedVersion: number) => {
    if (record.version !== expectedVersion) throw new ConflictError(expectedVersion, record.version);
  };

  const createRecord = <T extends MutableRecord>(entity: WorkspaceEntity, record: Omit<T, keyof RecordMetadata>): T => {
    const timestamp = now();
    const created = { ...record, id: nextId(), workspaceId: state.workspaceId, version: 1, createdAt: timestamp, updatedAt: timestamp, deletedAt: null } as T;
    recordsFor(entity).push(created);
    audit(entity, created.id, 'created');
    persistAndNotify();
    return clone(created);
  };

  const updateRecord = <T extends MutableRecord>(entity: WorkspaceEntity, id: string, expectedVersion: number, patch: Partial<T>): T => {
    const current = findActive(entity, id) as T;
    assertVersion(current, expectedVersion);
    const updated = { ...current, ...patch, version: current.version + 1, updatedAt: now() } as T;
    const records = recordsFor(entity);
    records[records.indexOf(current)] = updated;
    audit(entity, id, 'updated');
    persistAndNotify();
    return clone(updated);
  };

  const deleteRecord = <T extends MutableRecord>(entity: WorkspaceEntity, id: string, expectedVersion: number): T => {
    const current = findActive(entity, id) as T;
    assertVersion(current, expectedVersion);
    const deleted = { ...current, version: current.version + 1, updatedAt: now(), deletedAt: now() } as T;
    const records = recordsFor(entity);
    records[records.indexOf(current)] = deleted;
    audit(entity, id, 'deleted');
    persistAndNotify();
    return clone(deleted);
  };

  const withoutMetadata = <T extends MutableRecord>(record: T): Omit<T, keyof RecordMetadata> => {
    const { id: _id, workspaceId: _workspaceId, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...input } = record;
    return input as Omit<T, keyof RecordMetadata>;
  };

  const toTask = (input: Partial<TaskInput>, current?: Task): Omit<Task, keyof RecordMetadata> => {
    const parsed = taskInputSchema.parse({ ...(current ? withoutMetadata(current) : {}), ...input, statusId: input.statusId ?? current?.statusId ?? 'status-new' });
    return { ...parsed, statusId: parsed.statusId ?? current?.statusId ?? 'status-new' };
  };
  const toComment = (input: Partial<CommentInput>, current?: Comment): Omit<Comment, keyof RecordMetadata> => ({ ...commentInputSchema.parse({ ...(current ? withoutMetadata(current) : {}), ...input }) });
  const toKnowledge = (input: Partial<KnowledgeInput>, current?: KnowledgeItem): Omit<KnowledgeItem, keyof RecordMetadata> => ({
    ...(current ? mergeKnowledgePatch(withoutMetadata(current), input) : knowledgeInputSchema.parse(input)),
  });
  const toContact = (input: Partial<ContactInput>, current?: Contact): Omit<Contact, keyof RecordMetadata> => ({ ...contactInputSchema.parse({ ...(current ? withoutMetadata(current) : {}), ...input }) });
  const toSecureItem = (input: Partial<SecureItemInput>, current?: SecureItemLink): Omit<SecureItemLink, keyof RecordMetadata> => ({ ...secureItemInputSchema.parse({ ...(current ? withoutMetadata(current) : {}), ...input }) });

  return {
    snapshot: () => visibleSnapshot(state),
    createTask: (input) => createRecord<Task>('task', toTask(input)),
    updateTask: (id, input, expectedVersion) => {
      const current = findActive('task', id) as Task;
      assertVersion(current, expectedVersion);
      return updateRecord<Task>('task', id, expectedVersion, toTask(input, current));
    },
    deleteTask: (id, expectedVersion) => deleteRecord<Task>('task', id, expectedVersion),
    createComment: (input) => createRecord<Comment>('comment', toComment(input)),
    updateComment: (id, input, expectedVersion) => {
      const current = findActive('comment', id) as Comment;
      assertVersion(current, expectedVersion);
      return updateRecord<Comment>('comment', id, expectedVersion, toComment(input, current));
    },
    deleteComment: (id, expectedVersion) => deleteRecord<Comment>('comment', id, expectedVersion),
    createKnowledge: (input) => createRecord<KnowledgeItem>('knowledge', toKnowledge(input)),
    updateKnowledge: (id, input, expectedVersion) => {
      const current = findActive('knowledge', id) as KnowledgeItem;
      assertVersion(current, expectedVersion);
      return updateRecord<KnowledgeItem>('knowledge', id, expectedVersion, toKnowledge(input, current));
    },
    deleteKnowledge: (id, expectedVersion) => deleteRecord<KnowledgeItem>('knowledge', id, expectedVersion),
    createContact: (input) => createRecord<Contact>('contact', toContact(input)),
    updateContact: (id, input, expectedVersion) => {
      const current = findActive('contact', id) as Contact;
      assertVersion(current, expectedVersion);
      return updateRecord<Contact>('contact', id, expectedVersion, toContact(input, current));
    },
    deleteContact: (id, expectedVersion) => deleteRecord<Contact>('contact', id, expectedVersion),
    createSecureItem: (input) => createRecord<SecureItemLink>('secureItem', toSecureItem(input)),
    updateSecureItem: (id, input, expectedVersion) => {
      const current = findActive('secureItem', id) as SecureItemLink;
      assertVersion(current, expectedVersion);
      return updateRecord<SecureItemLink>('secureItem', id, expectedVersion, toSecureItem(input, current));
    },
    deleteSecureItem: (id, expectedVersion) => deleteRecord<SecureItemLink>('secureItem', id, expectedVersion),
    restore: (entity, id, expectedVersion): RestorableRecord => {
      const current = recordsFor(entity).find((record) => record.id === id);
      assertRestorableRecord(current, expectedVersion, Date.parse(now()));
      const restored = { ...current, version: current.version + 1, updatedAt: now(), deletedAt: null };
      const records = recordsFor(entity);
      records[records.indexOf(current)] = restored;
      audit(entity, id, 'restored');
      persistAndNotify();
      return clone(restored);
    },
    hydrate: () => {
      const persisted = persistence.load();
      if (!isSnapshot(persisted)) return;
      state = clone(persisted);
      initializeGeneratedIds();
      notify();
    },
    search: (query) => searchWorkspace(visibleSnapshot(state), query),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
