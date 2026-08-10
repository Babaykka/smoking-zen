// @vitest-environment node

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { createSupabaseTaskStore } from '@/server/task-api';

type RowMap = Record<string, unknown[]>;

function snapshotClient(rows: RowMap): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      let visibility = 'all';
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        is: vi.fn((column: string) => { if (column === 'deleted_at') visibility = 'active'; return chain; }),
        not: vi.fn((column: string) => { if (column === 'deleted_at') visibility = 'deleted'; return chain; }),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (value: unknown) => void) => resolve({ data: rows[`${table}:${visibility}`] ?? rows[table] ?? [], error: null }),
      };
      return chain;
    }),
  } as unknown as SupabaseClient;
}

describe('production workspace snapshot', () => {
  it('loads deleted records into Trash and append-only audit events into reachable history', async () => {
    const deletedTask = {
      id: '10000000-0000-4000-8000-000000000001', workspace_id: '30000000-0000-4000-8000-000000000001',
      title: 'Удалённая задача', description: '', priority: 3, status_id: '20000000-0000-4000-8000-000000000001',
      section_id: null, assignee_id: null, due_at: null, version: 2,
      created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-02T10:00:00.000Z', deleted_at: '2026-08-02T10:00:00.000Z',
    };
    const audit = {
      id: '40000000-0000-4000-8000-000000000001', workspace_id: deletedTask.workspace_id,
      entity_type: 'task', entity_id: deletedTask.id, action: 'deleted', occurred_at: '2026-08-02T10:00:00.000Z',
    };
    const store = createSupabaseTaskStore(snapshotClient({
      'tasks:deleted': [deletedTask],
      audit_events: [audit],
    }));

    const snapshot = await store.getWorkspaceData(deletedTask.workspace_id);

    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.trashItems).toEqual([{
      entity: 'task', id: deletedTask.id, title: deletedTask.title, version: 2, deletedAt: deletedTask.deleted_at,
    }]);
    expect(snapshot.auditEvents).toEqual([{
      id: audit.id, workspaceId: deletedTask.workspace_id, entity: 'task', entityId: deletedTask.id,
      action: 'deleted', occurredAt: audit.occurred_at,
    }]);
  });

  it('shows only individually archived ready attachments and bounds immutable audit loading', async () => {
    const workspaceId = '30000000-0000-4000-8000-000000000001';
    const liveTask = {
      id: '10000000-0000-4000-8000-000000000002', workspace_id: workspaceId, title: 'Живая задача', description: '', priority: 3,
      status_id: '20000000-0000-4000-8000-000000000001', section_id: null, assignee_id: null, due_at: null, version: 1,
      created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-01T10:00:00.000Z', deleted_at: null,
    };
    const deletedTask = { ...liveTask, id: '10000000-0000-4000-8000-000000000003', title: 'Удалённая задача', version: 2, deleted_at: '2026-08-02T09:00:00.000Z' };
    const individual = {
      id: '50000000-0000-4000-8000-000000000001', workspace_id: workspaceId, task_id: liveTask.id, knowledge_item_id: null,
      name: 'scheme.pdf', mime_type: 'application/pdf', size_bytes: 2048, state: 'ready', version: 4,
      deleted_at: '2026-08-02T10:00:00.000Z',
    };
    const inherited = { ...individual, id: '50000000-0000-4000-8000-000000000002', task_id: deletedTask.id, name: 'inherited.pdf', deleted_at: deletedTask.deleted_at };
    const liveComment = {
      id: '60000000-0000-4000-8000-000000000001', workspace_id: workspaceId, task_id: liveTask.id,
      author_id: '70000000-0000-4000-8000-000000000001', body: 'Живой комментарий', version: 1,
      created_at: '2026-08-02T10:00:00.000Z', updated_at: '2026-08-02T10:00:00.000Z', deleted_at: null,
    };
    const orphanedLiveComment = { ...liveComment, id: '60000000-0000-4000-8000-000000000002', task_id: deletedTask.id, body: 'Скрытый комментарий' };
    const client = snapshotClient({
      'tasks:active': [liveTask], 'tasks:deleted': [deletedTask], 'attachments:deleted': [individual, inherited],
      'comments:active': [liveComment, orphanedLiveComment],
    });
    const store = createSupabaseTaskStore(client);

    const snapshot = await store.getWorkspaceData(workspaceId);

    expect(snapshot.trashItems).toContainEqual({
      entity: 'attachment', id: individual.id, title: individual.name, version: 4, deletedAt: individual.deleted_at,
      attachment: { id: individual.id, name: individual.name, mimeType: individual.mime_type, size: individual.size_bytes, version: 4 },
      parentType: 'task', parentId: liveTask.id,
    });
    expect(snapshot.trashItems).not.toContainEqual(expect.objectContaining({ id: inherited.id }));
    expect(snapshot.comments.map((comment) => comment.body)).toEqual(['Живой комментарий']);
    const auditQuery = vi.mocked(client.from).mock.results.find((result) => {
      const value = result.value as { select?: ReturnType<typeof vi.fn> };
      return value.select && vi.mocked(client.from).mock.calls[vi.mocked(client.from).mock.results.indexOf(result)]?.[0] === 'audit_events';
    })?.value as { limit?: ReturnType<typeof vi.fn> } | undefined;
    expect(auditQuery?.limit).toHaveBeenCalledWith(200);
  });
});
