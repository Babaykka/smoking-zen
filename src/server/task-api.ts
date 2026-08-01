import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { ConflictError } from '@/data/workspace-repository';
import type { CommentInput, TaskInput, TaskPatchInput } from '@/domain/schemas';
import type { Comment, Priority, Section, Task, TaskStatus, WorkspaceMember, WorkspaceSnapshot } from '@/domain/types';
import { requireProductionEnvironment } from '@/server/env';
import { readSessionCookie } from '@/server/http';
import { readSession } from '@/server/session';
import { createServiceSupabaseClient, createSupabaseAccessStore } from '@/server/supabase';

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

type DataResult = { data: unknown; error: { message?: string } | null };

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

function taskFromRow(value: unknown): Task {
  const row = value as Record<string, unknown>;
  return {
    ...metadata(row), title: String(row.title), description: String(row.description ?? ''), priority: Number(row.priority) as Priority,
    statusId: String(row.status_id), sectionId: row.section_id === null ? null : String(row.section_id),
    assigneeId: row.assignee_id === null ? null : String(row.assignee_id), dueAt: row.due_at === null ? null : String(row.due_at), attachments: [],
  };
}

function commentFromRow(value: unknown): Comment {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), taskId: String(row.task_id), authorId: String(row.author_id), body: String(row.body) };
}

function statusFromRow(value: unknown): TaskStatus {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), name: String(row.name), position: Number(row.position) };
}

function sectionFromRow(value: unknown): Section {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), name: String(row.name), position: Number(row.position) };
}

function memberFromRow(value: unknown): WorkspaceMember {
  const row = value as Record<string, unknown>;
  return { ...metadata(row), name: String(row.display_name), role: row.role === 'owner' ? 'owner' : 'member', active: Boolean(row.active) };
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
      const [tasksResult, commentsResult, statusesResult, sectionsResult, membersResult] = await Promise.all([
        visible('tasks'), visible('comments'), visible('task_statuses').order('position'), visible('sections').order('position'), visible('workspace_members'),
      ]) as DataResult[];
      const tasks = assertResult(tasksResult) as unknown[];
      const comments = assertResult(commentsResult) as unknown[];
      const statuses = assertResult(statusesResult) as unknown[];
      const sections = assertResult(sectionsResult) as unknown[];
      const members = assertResult(membersResult) as unknown[];
      return {
        workspaceId,
        tasks: tasks.map(taskFromRow), comments: comments.map(commentFromRow), taskStatuses: statuses.map(statusFromRow),
        sections: sections.map(sectionFromRow), members: members.map(memberFromRow), knowledge: [], contacts: [], secureItems: [],
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
      return data ? taskFromRow(data) : conflictOrMissing(workspaceId, id, expectedVersion);
    },

    async deleteTask(workspaceId, id, expectedVersion, actorUserId) {
      const timestamp = new Date().toISOString();
      const result = await createActorClient(actorUserId).from('tasks').update({ deleted_at: timestamp, updated_at: timestamp, version: expectedVersion + 1 })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).is('deleted_at', null).select('*').maybeSingle() as DataResult;
      const data = assertResult(result);
      return data ? taskFromRow(data) : conflictOrMissing(workspaceId, id, expectedVersion);
    },

    async restoreTask(workspaceId, id, expectedVersion, actorUserId) {
      const current = await currentTask(workspaceId, id);
      if (!current) throw new Error('Запись не найдена');
      if (Number(current.version) !== expectedVersion) throw new ConflictError(expectedVersion, Number(current.version));
      const deletedAt = Date.parse(String(current.deleted_at));
      if (!Number.isFinite(deletedAt) || Date.now() >= deletedAt + 30 * 24 * 60 * 60 * 1_000) throw new Error('Срок восстановления истёк');
      const result = await createActorClient(actorUserId).from('tasks').update({ deleted_at: null, updated_at: new Date().toISOString(), version: expectedVersion + 1 })
        .eq('workspace_id', workspaceId).eq('id', id).eq('version', expectedVersion).select('*').maybeSingle() as DataResult;
      const data = assertResult(result);
      return data ? taskFromRow(data) : conflictOrMissing(workspaceId, id, expectedVersion);
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
