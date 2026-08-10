import {
  commentInputSchema,
  contactInputSchema,
  knowledgeInputSchema,
  mergeKnowledgePatch,
  secureItemInputSchema,
  secureItemPatchSchema,
  taskInputSchema,
  type CommentInput,
  type ContactInput,
  type KnowledgeInput,
  type SecureItemInput,
  type TaskInput,
} from '@/domain/schemas';
import { searchWorkspace } from '@/domain/search';
import type {
  Attachment,
  AuditAction,
  Comment,
  Contact,
  KnowledgeItem,
  RecordMetadata,
  SecureItemSummary,
  Task,
  WorkspaceEntity,
  WorkspaceSnapshot,
  TrashItem,
} from '@/domain/types';
import { demoSeed, demoSecureItemRevealUrls } from '@/data/demo-seed';
import {
  assertRestorableRecord,
  ConflictError,
  type RestorableRecord,
  type RestorableEntity,
  type WorkspaceListener,
  type WorkspacePersistence,
  type WorkspaceRepository,
} from '@/data/workspace-repository';
import { z } from 'zod';

type RepositoryOptions = {
  persistence?: WorkspacePersistence;
  clock?: () => string;
  idFactory?: () => string;
  seed?: WorkspaceSnapshot;
  loadPersisted?: boolean;
  secureItemRevealUrls?: Readonly<Record<string, string>>;
};

type MutableRecord = Task | Comment | KnowledgeItem | Contact | SecureItemSummary;

const DEMO_SNAPSHOT_SCHEMA_VERSION = 1;
const timestampSchema = z.string().datetime({ offset: true });
const metadataShape = {
  id: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: timestampSchema.nullable(),
} as const;
const attachmentSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  size: z.number().int().positive().max(25 * 1024 * 1024),
  version: z.number().int().positive().default(1),
});
const taskStatusSnapshotSchema = z.object({
  ...metadataShape, name: z.string().min(1).max(120), position: z.number().int(), isCompleted: z.boolean(),
});
const sectionSnapshotSchema = z.object({
  ...metadataShape, name: z.string().min(1).max(120), position: z.number().int(),
});
const taskSnapshotSchema = z.object({
  ...metadataShape,
  title: z.string().min(1).max(280), description: z.string().max(20_000), priority: z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
  ]),
  statusId: z.string().min(1).max(200), sectionId: z.string().min(1).max(200).nullable(),
  assigneeId: z.string().min(1).max(200).nullable(), dueAt: timestampSchema.nullable(),
  attachments: z.array(attachmentSchema).max(20),
});
const commentSnapshotSchema = z.object({
  ...metadataShape, taskId: z.string().min(1).max(200), authorId: z.string().min(1).max(200), body: z.string().min(1).max(10_000),
});
const knowledgeSnapshotSchema = z.object({
  ...metadataShape,
  title: z.string().min(1).max(280), body: z.string().max(30_000), kind: z.enum(['note', 'instruction', 'document', 'link']),
  linkUrl: z.string().url().max(2_000).nullable(), sectionId: z.string().min(1).max(200).nullable(),
  attachments: z.array(attachmentSchema).max(20),
});
const contactSnapshotSchema = z.object({
  ...metadataShape,
  name: z.string().min(1).max(280), category: z.enum(['supplier', 'service', 'landlord', 'cleaning', 'other']),
  notes: z.string().max(10_000),
  methods: z.array(z.object({ kind: z.enum(['phone', 'telegram', 'whatsapp']), value: z.string().min(1).max(300) })).max(10),
});
const memberSnapshotSchema = z.object({
  ...metadataShape, name: z.string().min(1).max(280), role: z.enum(['owner', 'member']), active: z.boolean(),
});
const secureItemSnapshotSchema = z.object({
  ...metadataShape,
  title: z.string().min(1).max(280), purpose: z.string().max(2_000), owner: z.string().max(280),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(), cardBank: z.string().max(280).nullable(),
  cardHolder: z.string().max(280).nullable(), cardPurpose: z.string().max(2_000).nullable(),
  lastFour: z.string().regex(/^\d{4}$/u).nullable(),
});
const auditEventSnapshotSchema = z.object({
  id: z.string().min(1).max(200), workspaceId: z.string().min(1).max(200),
  entity: z.enum(['task', 'comment', 'knowledge', 'contact', 'secureItem', 'attachment']), entityId: z.string().min(1).max(200),
  action: z.enum(['created', 'updated', 'deleted', 'restored']), occurredAt: timestampSchema,
});
const notificationSnapshotSchema = z.object({
  ...metadataShape, eventId: z.string().min(1).max(200), channel: z.literal('telegram'), deliveredAt: timestampSchema.nullable(),
});
const trashItemSnapshotSchema = z.object({
  entity: z.enum(['task', 'knowledge', 'contact', 'secureItem', 'attachment']),
  id: z.string().min(1).max(200), title: z.string().min(1).max(280), version: z.number().int().positive(),
  deletedAt: timestampSchema, attachment: attachmentSchema.optional(), parentType: z.enum(['task', 'knowledge']).optional(),
  parentId: z.string().min(1).max(200).optional(),
});
const workspaceSnapshotSchema = z.object({
  workspaceId: z.string().min(1).max(200),
  taskStatuses: z.array(taskStatusSnapshotSchema), sections: z.array(sectionSnapshotSchema), tasks: z.array(taskSnapshotSchema),
  comments: z.array(commentSnapshotSchema), knowledge: z.array(knowledgeSnapshotSchema), contacts: z.array(contactSnapshotSchema),
  members: z.array(memberSnapshotSchema), secureItems: z.array(secureItemSnapshotSchema), auditEvents: z.array(auditEventSnapshotSchema),
  notificationDeliveries: z.array(notificationSnapshotSchema),
  trashItems: z.array(trashItemSnapshotSchema).default([]),
}).superRefine((snapshot, context) => {
  const collections = [
    snapshot.taskStatuses, snapshot.sections, snapshot.tasks, snapshot.comments, snapshot.knowledge,
    snapshot.contacts, snapshot.members, snapshot.secureItems, snapshot.auditEvents, snapshot.notificationDeliveries,
  ];
  for (const collection of collections) {
    if (collection.some((record) => record.workspaceId !== snapshot.workspaceId)) {
      context.addIssue({ code: 'custom', message: 'Workspace snapshot contains a foreign record.' });
      return;
    }
  }
});
const persistedSnapshotSchema = z.object({
  schemaVersion: z.literal(DEMO_SNAPSHOT_SCHEMA_VERSION),
  snapshot: workspaceSnapshotSchema,
});

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function decodePersistedSnapshot(value: unknown): WorkspaceSnapshot | null {
  const versioned = persistedSnapshotSchema.safeParse(value);
  if (versioned.success) return versioned.data.snapshot as WorkspaceSnapshot;
  const legacy = workspaceSnapshotSchema.safeParse(value);
  return legacy.success ? legacy.data as WorkspaceSnapshot : null;
}

function encodePersistedSnapshot(state: WorkspaceSnapshot): unknown {
  return { schemaVersion: DEMO_SNAPSHOT_SCHEMA_VERSION, snapshot: workspaceSnapshotSchema.parse(state) };
}

function visibleSnapshot(state: WorkspaceSnapshot): WorkspaceSnapshot {
  const active = <T extends RecordMetadata>(records: T[]) => records.filter((record) => record.deletedAt === null);
  const snapshot = clone(state);
  snapshot.trashItems = [
    ...(snapshot.trashItems ?? []).filter((item) => item.entity === 'attachment'),
    ...snapshot.tasks.filter((record) => record.deletedAt !== null).map((record) => ({ entity: 'task' as const, id: record.id, title: record.title, version: record.version, deletedAt: record.deletedAt! })),
    ...snapshot.knowledge.filter((record) => record.deletedAt !== null).map((record) => ({ entity: 'knowledge' as const, id: record.id, title: record.title, version: record.version, deletedAt: record.deletedAt! })),
    ...snapshot.contacts.filter((record) => record.deletedAt !== null).map((record) => ({ entity: 'contact' as const, id: record.id, title: record.name, version: record.version, deletedAt: record.deletedAt! })),
    ...snapshot.secureItems.filter((record) => record.deletedAt !== null).map((record) => ({ entity: 'secureItem' as const, id: record.id, title: record.title, version: record.version, deletedAt: record.deletedAt! })),
  ].sort((left, right) => Date.parse(right.deletedAt) - Date.parse(left.deletedAt));
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
  const decoded = decodePersistedSnapshot(loaded);
  let state = decoded ? clone(decoded) : clone(options.seed ?? demoSeed);
  state.trashItems ??= [];
  state.secureItems = state.secureItems.map((item) => ({
    id: item.id,
    workspaceId: item.workspaceId,
    title: item.title,
    purpose: typeof item.purpose === 'string' ? item.purpose : '',
    owner: typeof item.owner === 'string' ? item.owner : '',
    reviewDate: typeof item.reviewDate === 'string' ? item.reviewDate : null,
    cardBank: typeof item.cardBank === 'string' ? item.cardBank : null,
    cardHolder: typeof item.cardHolder === 'string' ? item.cardHolder : null,
    cardPurpose: typeof item.cardPurpose === 'string' ? item.cardPurpose : null,
    lastFour: typeof item.lastFour === 'string' ? item.lastFour : null,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  }));
  const secureItemRevealUrls = new Map(Object.entries(options.secureItemRevealUrls ?? demoSecureItemRevealUrls));
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
    for (const attachment of [
      ...state.tasks.flatMap((task) => task.attachments),
      ...state.knowledge.flatMap((item) => item.attachments),
      ...(state.trashItems ?? []).flatMap((item) => item.attachment ? [item.attachment] : []),
    ]) existingIds.add(attachment.id);
  };
  initializeGeneratedIds();
  const nextId = options.idFactory ?? (() => {
    let candidate = `demo-${++generatedIds}`;
    while (existingIds.has(candidate)) candidate = `demo-${++generatedIds}`;
    existingIds.add(candidate);
    return candidate;
  });

  const recordCollections: Record<RestorableEntity, keyof Pick<WorkspaceSnapshot, 'tasks' | 'comments' | 'knowledge' | 'contacts' | 'secureItems'>> = {
    task: 'tasks', comment: 'comments', knowledge: 'knowledge', contact: 'contacts', secureItem: 'secureItems',
  };

  const recordsFor = (entity: RestorableEntity): MutableRecord[] => state[recordCollections[entity]] as MutableRecord[];

  const findActive = (entity: RestorableEntity, id: string): MutableRecord => {
    const record = recordsFor(entity).find((candidate) => candidate.id === id && candidate.deletedAt === null);
    if (!record) throw new Error('Запись не найдена');
    return record;
  };

  const notify = () => {
    for (const listener of listeners) listener(visibleSnapshot(state));
  };

  const persistAndNotify = () => {
    persistence.save(encodePersistedSnapshot(state));
    notify();
  };

  const audit = (entity: WorkspaceEntity, entityId: string, action: AuditAction) => {
    state.auditEvents.push({ id: nextId(), workspaceId: state.workspaceId, entity, entityId, action, occurredAt: now() });
  };

  const assertVersion = (record: MutableRecord, expectedVersion: number) => {
    if (record.version !== expectedVersion) throw new ConflictError(expectedVersion, record.version);
  };

  const createRecord = <T extends MutableRecord>(entity: RestorableEntity, record: Omit<T, keyof RecordMetadata>): T => {
    const timestamp = now();
    const created = { ...record, id: nextId(), workspaceId: state.workspaceId, version: 1, createdAt: timestamp, updatedAt: timestamp, deletedAt: null } as T;
    recordsFor(entity).push(created);
    audit(entity, created.id, 'created');
    persistAndNotify();
    return clone(created);
  };

  const updateRecord = <T extends MutableRecord>(entity: RestorableEntity, id: string, expectedVersion: number, patch: Partial<T>): T => {
    const current = findActive(entity, id) as T;
    assertVersion(current, expectedVersion);
    const updated = { ...current, ...patch, version: current.version + 1, updatedAt: now() } as T;
    const records = recordsFor(entity);
    records[records.indexOf(current)] = updated;
    audit(entity, id, 'updated');
    persistAndNotify();
    return clone(updated);
  };

  const deleteRecord = <T extends MutableRecord>(entity: RestorableEntity, id: string, expectedVersion: number): T => {
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
    const result = taskInputSchema.safeParse({ ...(current ? withoutMetadata(current) : {}), ...input, statusId: input.statusId ?? current?.statusId ?? 'status-new' });
    if (!result.success) throw new Error(result.error.issues[0]?.message ?? 'Проверьте данные задачи.');
    const parsed = result.data;
    return { ...parsed, statusId: parsed.statusId ?? current?.statusId ?? 'status-new' };
  };
  const toComment = (input: Partial<CommentInput>, current?: Comment): Omit<Comment, keyof RecordMetadata> => ({ ...commentInputSchema.parse({ ...(current ? withoutMetadata(current) : {}), ...input }) });
  const toKnowledge = (input: Partial<KnowledgeInput>, current?: KnowledgeItem): Omit<KnowledgeItem, keyof RecordMetadata> => ({
    ...(current ? mergeKnowledgePatch(withoutMetadata(current), input) : knowledgeInputSchema.parse(input)),
  });
  const toContact = (input: Partial<ContactInput>, current?: Contact): Omit<Contact, keyof RecordMetadata> => ({ ...contactInputSchema.parse({ ...(current ? withoutMetadata(current) : {}), ...input }) });
  const secureSummary = (input: SecureItemInput): Omit<SecureItemSummary, keyof RecordMetadata> => {
    const { externalUrl: _externalUrl, ...summary } = secureItemInputSchema.parse(input);
    return summary;
  };

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
    createSecureItem: (input) => {
      const parsed = secureItemInputSchema.parse(input);
      const created = createRecord<SecureItemSummary>('secureItem', secureSummary(parsed));
      secureItemRevealUrls.set(created.id, parsed.externalUrl);
      return created;
    },
    updateSecureItem: (id, input, expectedVersion) => {
      const current = findActive('secureItem', id) as SecureItemSummary;
      assertVersion(current, expectedVersion);
      const parsed = secureItemPatchSchema.parse(input);
      const { externalUrl, ...summaryPatch } = parsed;
      const updated = updateRecord<SecureItemSummary>('secureItem', id, expectedVersion, summaryPatch);
      if (externalUrl !== undefined) secureItemRevealUrls.set(id, externalUrl);
      return updated;
    },
    deleteSecureItem: (id, expectedVersion) => deleteRecord<SecureItemSummary>('secureItem', id, expectedVersion),
    deleteAttachment: (id, expectedVersion): TrashItem => {
      const task = state.tasks.find((item) => item.deletedAt === null && item.attachments.some((attachment) => attachment.id === id));
      const knowledge = state.knowledge.find((item) => item.deletedAt === null && item.attachments.some((attachment) => attachment.id === id));
      const parent = task ?? knowledge;
      const attachment = parent?.attachments.find((item) => item.id === id);
      if (!parent || !attachment) throw new Error('Файл не найден.');
      const actualVersion = attachment.version ?? 1;
      if (actualVersion !== expectedVersion) throw new ConflictError(expectedVersion, actualVersion);
      const deletedAt = now();
      const archived: Attachment = { ...attachment, version: actualVersion + 1 };
      parent.attachments = parent.attachments.filter((item) => item.id !== id);
      const item: TrashItem = {
        entity: 'attachment', id, title: attachment.name, version: archived.version!, deletedAt,
        attachment: archived, parentType: task ? 'task' : 'knowledge', parentId: parent.id,
      };
      state.trashItems = [...(state.trashItems ?? []).filter((candidate) => !(candidate.entity === 'attachment' && candidate.id === id)), item];
      audit('attachment', id, 'deleted');
      persistAndNotify();
      return clone(item);
    },
    restoreAttachment: (id, expectedVersion): Attachment => {
      const item = (state.trashItems ?? []).find((candidate) => candidate.entity === 'attachment' && candidate.id === id);
      assertRestorableRecord(item, expectedVersion, Date.parse(now()));
      if (!item.attachment || !item.parentType || !item.parentId) throw new Error('Данные файла для восстановления повреждены.');
      const parents = item.parentType === 'task' ? state.tasks : state.knowledge;
      const parent = parents.find((candidate) => candidate.id === item.parentId && candidate.deletedAt === null);
      if (!parent) throw new Error('Сначала восстановите запись, к которой был прикреплён файл.');
      const restored: Attachment = { ...item.attachment, version: item.version + 1 };
      parent.attachments = [...parent.attachments.filter((candidate) => candidate.id !== id), restored];
      state.trashItems = (state.trashItems ?? []).filter((candidate) => !(candidate.entity === 'attachment' && candidate.id === id));
      audit('attachment', id, 'restored');
      persistAndNotify();
      return clone(restored);
    },
    revealSecureItem: (id) => {
      findActive('secureItem', id);
      const externalUrl = secureItemRevealUrls.get(id);
      if (!externalUrl) throw new Error('Ссылка доступна только до перезагрузки демо-режима.');
      return { externalUrl };
    },
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
      const decodedSnapshot = decodePersistedSnapshot(persisted);
      if (!decodedSnapshot) return;
      state = clone(decodedSnapshot);
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
