// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createCommentsHandler } from '@/app/api/comments/route';
import { createTaskItemHandler } from '@/app/api/tasks/[id]/route';
import { createTasksHandler } from '@/app/api/tasks/route';
import {
  ConflictError,
  RestoreExpiredError,
  RestoreNotDeletedError,
  RestoreNotFoundError,
} from '@/data/workspace-repository';
import { demoSeed } from '@/data/demo-seed';
import { CommentParentNotFoundError, type TaskApiStore, type TaskSessionActor } from '@/server/task-api';

const actor: TaskSessionActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  membershipId: '22222222-2222-4222-8222-222222222222',
};
const taskId = '44444444-4444-4444-8444-444444444444';

function store(): TaskApiStore {
  return {
    getWorkspaceData: vi.fn().mockResolvedValue(demoSeed),
    createTask: vi.fn().mockResolvedValue(demoSeed.tasks[0]),
    updateTask: vi.fn().mockResolvedValue({ ...demoSeed.tasks[0], version: 2 }),
    deleteTask: vi.fn().mockResolvedValue({ ...demoSeed.tasks[0], version: 2, deletedAt: '2026-08-02T12:00:00.000Z' }),
    restoreTask: vi.fn().mockResolvedValue({ ...demoSeed.tasks[0], version: 3, deletedAt: null }),
    createComment: vi.fn().mockResolvedValue({ ...demoSeed.comments[0], id: 'comment-1' }),
  };
}

const jsonRequest = (url: string, method: string, body?: unknown) => new Request(url, {
  method,
  headers: { 'content-type': 'application/json', origin: 'https://app.example' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('task routes', () => {
  it('fails closed when no valid session exists', async () => {
    const handler = createTasksHandler({ appOrigin: 'https://app.example', store: store(), authenticate: async () => null, requestId: () => 'request-1' });
    const response = await handler(new Request('https://app.example/api/tasks'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ data: null, error: { code: 'session_invalid', message: 'Требуется авторизация.' }, requestId: 'request-1' });
  });

  it('lists and creates tasks only inside the authenticated workspace', async () => {
    const taskStore = store();
    const handler = createTasksHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-2' });

    const listResponse = await handler(new Request('https://app.example/api/tasks'));
    expect(listResponse.status).toBe(200);
    expect(taskStore.getWorkspaceData).toHaveBeenCalledWith(actor.workspaceId);

    const createResponse = await handler(jsonRequest('https://app.example/api/tasks', 'POST', { title: 'Новая задача' }));
    expect(createResponse.status).toBe(201);
    expect(taskStore.createTask).toHaveBeenCalledWith(actor.workspaceId, expect.objectContaining({ title: 'Новая задача', priority: 3 }), actor.userId);

    const injected = await handler(jsonRequest('https://app.example/api/tasks', 'POST', { title: 'Чужая', workspaceId: 'another-workspace' }));
    expect(injected.status).toBe(400);
  });

  it('rejects unsafe persisted task and comment URLs before store access', async () => {
    const taskStore = store();
    const tasks = createTasksHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'unsafe-task-url' });
    const taskResponse = await tasks(jsonRequest('https://app.example/api/tasks', 'POST', {
      title: 'Новая задача', description: 'https://example.com/guide?lang=ru',
    }));
    expect(taskResponse.status).toBe(400);
    expect(taskStore.createTask).not.toHaveBeenCalled();

    const comments = createCommentsHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'unsafe-comment-url' });
    const commentResponse = await comments(jsonRequest('https://app.example/api/comments', 'POST', {
      taskId, body: `https://example.com/files/${'%2561'.repeat(64)}`,
    }));
    expect(commentResponse.status).toBe(400);
    expect(taskStore.createComment).not.toHaveBeenCalled();
  });

  it('returns 409 for a stale version without overwriting', async () => {
    const taskStore = store();
    vi.mocked(taskStore.updateTask).mockRejectedValue(new ConflictError(1, 2));
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-3' });

    const response = await handler(jsonRequest(`https://app.example/api/tasks/${taskId}`, 'PATCH', { input: { title: 'Моя версия' }, expectedVersion: 1 }), { params: Promise.resolve({ id: taskId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ data: { expectedVersion: 1, actualVersion: 2 }, error: { code: 'version_conflict' } });
  });

  it('passes a title-only patch without materializing create defaults', async () => {
    const taskStore = store();
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-patch' });

    const response = await handler(jsonRequest(`https://app.example/api/tasks/${taskId}`, 'PATCH', {
      input: { title: 'Только новое название' }, expectedVersion: 1,
    }), { params: Promise.resolve({ id: taskId }) });

    expect(response.status).toBe(200);
    expect(taskStore.updateTask).toHaveBeenCalledWith(actor.workspaceId, taskId, { title: 'Только новое название' }, 1, actor.userId);
  });

  it('soft deletes and restores a task with an expected version', async () => {
    const taskStore = store();
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-4' });

    expect((await handler(jsonRequest(`https://app.example/api/tasks/${taskId}`, 'DELETE', { expectedVersion: 2 }), { params: Promise.resolve({ id: taskId }) })).status).toBe(200);
    expect(taskStore.deleteTask).toHaveBeenCalledWith(actor.workspaceId, taskId, 2, actor.userId);

    expect((await handler(jsonRequest(`https://app.example/api/tasks/${taskId}`, 'PATCH', { action: 'restore', expectedVersion: 3 }), { params: Promise.resolve({ id: taskId }) })).status).toBe(200);
    expect(taskStore.restoreTask).toHaveBeenCalledWith(actor.workspaceId, taskId, 3, actor.userId);
  });

  it('maps typed task restore failures to stable recovery responses', async () => {
    const taskStore = store();
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-restore' });
    const failures = [
      { error: new RestoreNotFoundError(), status: 404, code: 'record_not_found' },
      { error: new RestoreNotDeletedError(), status: 409, code: 'restore_not_deleted' },
      { error: new RestoreExpiredError(), status: 410, code: 'restore_expired' },
    ];

    for (const failure of failures) {
      vi.mocked(taskStore.restoreTask).mockRejectedValueOnce(failure.error);
      const response = await handler(
        jsonRequest(`https://app.example/api/tasks/${taskId}`, 'PATCH', { action: 'restore', expectedVersion: 3 }),
        { params: Promise.resolve({ id: taskId }) },
      );
      expect(response.status).toBe(failure.status);
      expect(await response.json()).toMatchObject({ data: null, error: { code: failure.code } });
    }

    vi.mocked(taskStore.restoreTask).mockRejectedValueOnce(new ConflictError(2, 3));
    const conflict = await handler(
      jsonRequest(`https://app.example/api/tasks/${taskId}`, 'PATCH', { action: 'restore', expectedVersion: 2 }),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      data: { expectedVersion: 2, actualVersion: 3 }, error: { code: 'version_conflict' },
    });
  });

  it('creates comments with the authenticated membership as author', async () => {
    const taskStore = store();
    const handler = createCommentsHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-5' });
    const response = await handler(jsonRequest('https://app.example/api/comments', 'POST', { taskId, authorId: 'attacker', body: 'Готово' }));

    expect(response.status).toBe(201);
    expect(taskStore.createComment).toHaveBeenCalledWith(actor.workspaceId, { taskId, authorId: actor.membershipId, body: 'Готово' }, actor.userId);
  });

  it('rejects malformed and deleted comment parents without creating an orphan', async () => {
    const taskStore = store();
    const handler = createCommentsHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-comment-parent' });
    const malformed = await handler(jsonRequest('https://app.example/api/comments', 'POST', { taskId: 'not-a-uuid', body: 'Готово' }));
    expect(malformed.status).toBe(400);
    expect(taskStore.createComment).not.toHaveBeenCalled();

    vi.mocked(taskStore.createComment).mockRejectedValueOnce(new CommentParentNotFoundError());
    const deleted = await handler(jsonRequest('https://app.example/api/comments', 'POST', { taskId, body: 'Готово' }));
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toMatchObject({ error: { code: 'task_not_found' } });
  });

  it('rejects malformed task identifiers before reaching a store', async () => {
    const taskStore = store();
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'bad-id' });
    const response = await handler(
      jsonRequest('https://app.example/api/tasks/not-a-uuid', 'DELETE', { expectedVersion: 1 }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    expect(response.status).toBe(400);
    expect(taskStore.deleteTask).not.toHaveBeenCalled();
  });
});
