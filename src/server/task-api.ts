import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { ConflictError } from '@/data/workspace-repository';
import type { CommentInput, TaskInput, TaskPatchInput } from '@/domain/schemas';
import type { Attachment, Comment, Contact, ContactMethod, KnowledgeItem, Priority, Section, Task, TaskStatus, WorkspaceMember, WorkspaceSnapshot } from '@/domain/types';
import { requireProductionEnvironment } from '@/server/env';
import { readSessionCookie } from '@/server/http';
import { isDatabaseVersionConflict, throwKnownRestoreDatabaseError } from '@/server/restore';
import { readSession } from '@/server/session';
import { createServiceSupabaseClient, createSupabaseAccessStore } from '@/server/supabase';
import { SECURE_ITEM_SUMMARY_COLUMNS, secureItemSummaryFromRow } from '@/server/secure-item-api';

export type TaskSessionActor = { userId: string; workspaceId: string; membershipId: string };

export interface TaskApiStore {
  getWorkspaceData(workspaceId: string): Promise<WorkspaceSnapshot>;
  createTask(workspaceId: string, input: TaskInput, actorUserId: string): Promise<Task>;
  updateTask(workspaceId: string, id: string, input: TaskPatchInput, expectedVersion: number, actorUserId: string): Promise<Task>;
  deleteTask(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<Task>;
  restoreTask(workspaceId: string, id: string, expectedVersion: number, actorUserId: string): Promise<Task>;
  createComment(workspaceId: string, input: CommentInput, actorUserId: string): Promise<Comment>;
}

export type TaskRouteDependencies = {
  appOrigin: string;
  store: TaskApiStore;
  authenticate: (request: Request) => Promise<TaskSessionActor | null>;
  requestId: () => string;
};

type DataResult = { data: unknown; error: { code?: string; message?: string } | null };

function assertResult(result: DataResult): unknown {
  if (result.error) throw new Error('Database operation failed.');
  return result.data;
}

function metadata(row: Record<string, unknown>) {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

function taskFromRow(value: unknown, attachments: Attachment[] = []): Task {
  const row = value as Record<string, unknown>;
  return {
    ...metadata(row), title: String(row.title), description: String(row.description ?? ''), priority: Number(row.priority) as Priority,
    statusId: String(row.status_id), sectionId: row.section_id === null ? null : String(row.section_id),
    assigneeId: row.assignee_id === null ? null : String(row.assignee_id), dueAt: row.due_at === null ? null : String(row.due_at), attachments,
  };
}

function commentFromRow(value: unknown): Comment {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), taskId: String(row.task_id), authorId: String(row.author_id), body: String(row.body) };
}

function statusFromRow(value: unknown): TaskStatus {
  const row = value as Record<string, unknown>;
  return {
    ...metadata(row),
    name: String(row.name),
    position: Number(row.position),
    isCompleted: Boolean(row.is_completed),
  };
}

function sectionFromRow(value: unknown): Section {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), name: String(row.name), position: Number(row.position) };
}

function memberFromRow(value: unknown): WorkspaceMember {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), name: String(row.display_name), role: row.role === 'owner' ? 'owner' : 'member', active: Boolean(row.active) };
}

function knowledgeFromRow(value: unknown, attachments: Attachment[] = []): KnowledgeItem {
  const row = value as Record<string, unknown>;
  return {
    ...metadata(row), title: String(row.title), body: String(row.body ?? ''), kind: row.kind as KnowledgeItem['kind'],
    linkUrl: row.link_url === null ? null : String(row.link_url), sectionId: row.section_id === null ? null : String(row.section_id), attachments,
  };
}

function contactMethodFromRow(value: unknown): ContactMethod {
  const row = value as Record<string, unknown>;
  return { kind: row.kind as ContactMethod['kind'], value: String(row.value) };
}

function contactFromRow(value: unknown, methods: ContactMethod[]): Contact {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), name: String(row.name), category: row.category as Contact['category'], notes: String(row.notes ?? ''), methods };
}

function attachmentFromRow(value: unknown): Attachment {
  const row = value as Record<string, unknown>;
  return { id: String(row.id), name: String(row.name), mimeType: String(row.mime_type), size: Number(row.size_bytes) };
}

function taskPatch(input: TaskPatchInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if ('title' in input) patch.title = input.title;
  if ('description' in input) patch.description = input.description;
  if ('priority' in input) patch.priority = input.priority;
  if ('statusId' in input) patch.status_id = input.statusId;
  if ('sectionId' in input) patch.section_id = input.sectionId;
  if ('assigneeId' in input) patch.assignee_id = input.assigneeId;
  if ('dueAt' in input) patch.due_at = input.dueAt;
  return patch;
}

export function createSupabaseTaskStore(
  client: SupabaseClient,
  createActorClient: (actorUserId: string) => SupabaseClient = () => client,
): TaskApiStore {
  const readyAttachments = async (workspaceId: string, column: 'task_id' | 'knowledge_item_id', id: string): Promise<Attachment[]> => {
    const result = await client.from('attachments').select('id,name,mime_type,size_bytes')
      .eq('workspace_id', workspaceId).eq(column, id).eq('state', 'ready').is('deleted_at', null).order('created_at') as DataResult;
    return (assertResult(result) as unknown[]).map(attachmentFromRow);
  };
  const currentTask = async (workspaceId: string, id: string): Promise<Record<string, unknown> | null> => {
    const result = await client.from('tasks').select('*').eq('workspace_id', workspaceId).eq('id', id).maybeSingle() as DataResult;
    return assertResult(result) as Record<string, unknown> | null;
  };

  const conflictOrMissing = async (workspaceId: string, id: string, expectedVersion: number): Promise<never> => {
    const current = await currentTask(workspaceId, id);
    if (!current) throw new Error('Запись не найдена');
    throw new ConflictError(expectedVersion, Number(current.version));
  };

  return {
    async getWorkspaceData(workspaceId) {
      const visible = (table: string) => client.from(table).select('*').eq('workspace_id', workspaceId).is('deleted_at', null);
      const [tasksResult, commentsResult, statusesResult, sectionsResult, membersResult, knowledgeResult, contactsResult, methodsResult, attachmentsResult, secureItemsResult] = await Promise.all([
        visible('tasks'), visible('comments'), visible('task_statuses').order('position'), visible('sections').order('position'), visible('workspace_members'),
        visible('knowledge_items').order('updated_at', { ascending: false }), visible('contacts').order('name'), visible('contact_methods').order('position'),
        visible('attachments').eq('state', 'ready').order('created_at'),
        client.from('secure_items').select(SECURE_ITEM_SUMMARY_COLUMNS).eq('workspace_id', workspaceId).is('deleted_at', null).order('updated_at', { ascending: false }),
      ]) as DataResult[];
      const tasks = assertResult(tasksResult) as unknown[];
      const comments = assertResult(commentsResult) as unknown[];
      const statuses = assertResult(statusesResult) as unknown[];
      const sections = assertResult(sectionsResult) as unknown[];
      const members = assertResult(membersResult) as unknown[];
      const knowledge = assertResult(knowledgeResult) as unknown[];
      const contacts = assertResult(contactsResult) as unknown[];
      const methods = assertResult(methodsResult) as unknown[];
      const attachments = assertResult(attachmentsResult) as unknown[];
      const secureItems = assertResult(secureItemsResult) as unknown[];
      const methodsByContact = new Map<string, ContactMethod[]>();
      for (const method of methods) {
        const row = method as Record<string, unknown>;
        const contactId = String(row.contact_id);
        methodsByContact.set(contactId, [...(methodsByContact.get(contactId) ?? []), contactMethodFromRow(row)]);
      }
      const attachmentsByTask = new Map<string, Attachment[]>();
      const attachmentsByKnowledge = new Map<string, Attachment[]>();
      for (const attachment of attachments) {
        const row = attachment as Record<string, unknown>;
        const parsed = attachmentFromRow(row);
        if (typeof row.task_id === 'string') attachmentsByTask.set(row.task_id, [...(attachmentsByTask.get(row.task_id) ?? []), parsed]);
        if (typeof row.knowledge_item_id === 'string') attachmentsByKnowledge.set(row.knowledge_item_id, [...(attachmentsByKnowledge.get(row.knowledge_item_id) ?? []), parsed]);
      }
      return {
        workspaceId,
        tasks: tasks.map((task) => taskFromRow(task, attachmentsByTask.get(String((task as Record<string, unknown>).id)) ?? [])), comments: comments.map(commentFromRow), taskStatuses: statuses.map(statusFromRow),
        sections: sections.map(sectionFromRow), members: members.map(memberFromRow), knowledge: knowledge.map((item) => knowledgeFromRow(item, attachmentsByKnowledge.get(String((item as Record<string, unknown>).id)) ?? [])),
        contacts: contacts.map((contact) => contactFromRow(contact, methodsByContact.get(String((contact as Record<string, unknown>).id)) ?? [])), secureItems: secureItems.map(secureItemSummaryFromRow),
        auditEvents: [], notificationDeliveries: [],
      };
    },

    async createTask(workspaceId, input, actorUserId) {
      const actorClient = createActorClient(actorUserId);
      let statusId = input.statusId;
      if (!statusId) {
        const statusResult = await client.from('task_statuses').select('id').eq('workspace_id', workspaceId).is('deleted_at', null).order('position').limit(1).maybeSingle() as DataResult;
        const status = assertResult(statusResult) as { id?: unknown } | null;
        if (!status || typeof status.id !== 'string') throw new Error('Статус по умолчанию не найден');
        statusId = status.id;
      }
      const result = await actorClient.from('tasks').insert({
        workspace_id: workspaceId, title: input.title, description: input.description ?? '', priority: input.priority ?? 3,
        status_id: statusId, section_id: input.sectionId ?? null, assignee_id: input.assigneeId ?? null, due_at: input.dueAt ?? null,
      }).select('*').single() as DataResult;
      return taskFromRow(assertResult(result));
    },

    async updateTask(workspaceId, id, input, expectedVersion, actorUserId) {
      const result = await createActorClient(actorUserId).from('tasks').update({ ...taskPatch(input), version: expectedVersion + 1, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).is('deleted_at', null).select('*').maybeSingle() as DataResult;
      const data = assertResult(result);
      return data ? taskFromRow(data, await readyAttachments(workspaceId, 'task_id', id)) : conflictOrMissing(workspaceId, id, expectedVersion);
    },

    async deleteTask(workspaceId, id, expectedVersion, actorUserId) {
      const timestamp = new Date().toISOString();
      const result = await createActorClient(actorUserId).from('tasks').update({ deleted_at: timestamp, updated_at: timestamp, version: expectedVersion + 1 })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).is('deleted_at', null).select('*').maybeSingle() as DataResult;
      const data = assertResult(result);
      return data ? taskFromRow(data) : conflictOrMissing(workspaceId, id, expectedVersion);
    },

    async restoreTask(workspaceId, id, expectedVersion, actorUserId) {
      const result = await createActorClient(actorUserId).rpc('restore_task_record', {
        p_workspace_id: workspaceId, p_task_id: id, p_expected_version: expectedVersion,
      }) as DataResult;
      if (isDatabaseVersionConflict(result.error)) return conflictOrMissing(workspaceId, id, expectedVersion);
      throwKnownRestoreDatabaseError(result.error, 'task_not_found');
      const rows = assertResult(result) as unknown[];
      const row = rows[0];
      if (row) return taskFromRow(row, await readyAttachments(workspaceId, 'task_id', id));
      throw new Error('Не удалось восстановить запись.');
    },

    async createComment(workspaceId, input, actorUserId) {
      const result = await createActorClient(actorUserId).from('comments').insert({ workspace_id: workspaceId, task_id: input.taskId, author_id: input.authorId, body: input.body }).select('*').single() as DataResult;
      return commentFromRow(assertResult(result));
    },
  };
}

export function createDefaultTaskRouteDependencies(): TaskRouteDependencies {
  const environment = requireProductionEnvironment();
  const client = createServiceSupabaseClient(environment);
  const accessStore = createSupabaseAccessStore(client);
  return {
    appOrigin: environment.appOrigin,
    store: createSupabaseTaskStore(
      client,
      (actorUserId) => createServiceSupabaseClient(environment, { 'x-smoking-zen-actor': actorUserId }),
    ),
    requestId: () => crypto.randomUUID(),
    async authenticate(request) {
      const identity = await readSession(readSessionCookie(request), { secret: environment.sessionSecret });
      if (!identity) return null;
      const membership = await accessStore.getActiveMembership(identity.userId, identity.workspaceId);
      if (!membership?.active || membership.membershipId !== identity.membershipId) return null;
      return { userId: identity.userId, workspaceId: identity.workspaceId, membershipId: identity.membershipId };
    },
  };
}
