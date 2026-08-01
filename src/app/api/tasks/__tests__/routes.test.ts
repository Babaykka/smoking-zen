// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { createCommentsHandler } from '@/app/api/comments/route';
import { createTaskItemHandler } from '@/app/api/tasks/[id]/route';
import { createTasksHandler } from '@/app/api/tasks/route';
import { ConflictError } from '@/data/workspace-repository';
import { demoSeed } from '@/data/demo-seed';
import type { TaskApiStore, TaskSessionActor } from '@/server/task-api';

const actor: TaskSessionActor = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  membershipId: '22222222-2222-4222-8222-222222222222',
};

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

  it('returns 409 for a stale version without overwriting', async () => {
    const taskStore = store();
    vi.mocked(taskStore.updateTask).mockRejectedValue(new ConflictError(1, 2));
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-3' });

    const response = await handler(jsonRequest('https://app.example/api/tasks/task-1', 'PATCH', { input: { title: 'Моя версия' }, expectedVersion: 1 }), { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ data: { expectedVersion: 1, actualVersion: 2 }, error: { code: 'version_conflict' } });
  });

  it('passes a title-only patch without materializing create defaults', async () => {
    const taskStore = store();
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-patch' });

    const response = await handler(jsonRequest('https://app.example/api/tasks/task-1', 'PATCH', {
      input: { title: 'Только новое название' }, expectedVersion: 1,
    }), { params: Promise.resolve({ id: 'task-1' }) });

    expect(response.status).toBe(200);
    expect(taskStore.updateTask).toHaveBeenCalledWith(actor.workspaceId, 'task-1', { title: 'Только новое название' }, 1, actor.userId);
  });

  it('soft deletes and restores a task with an expected version', async () => {
    const taskStore = store();
    const handler = createTaskItemHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-4' });

    expect((await handler(jsonRequest('https://app.example/api/tasks/task-1', 'DELETE', { expectedVersion: 2 }), { params: Promise.resolve({ id: 'task-1' }) })).status).toBe(200);
    expect(taskStore.deleteTask).toHaveBeenCalledWith(actor.workspaceId, 'task-1', 2, actor.userId);

    expect((await handler(jsonRequest('https://app.example/api/tasks/task-1', 'PATCH', { action: 'restore', expectedVersion: 3 }), { params: Promise.resolve({ id: 'task-1' }) })).status).toBe(200);
    expect(taskStore.restoreTask).toHaveBeenCalledWith(actor.workspaceId, 'task-1', 3, actor.userId);
  });

  it('creates comments with the authenticated membership as author', async () => {
    const taskStore = store();
    const handler = createCommentsHandler({ appOrigin: 'https://app.example', store: taskStore, authenticate: async () => actor, requestId: () => 'request-5' });
    const response = await handler(jsonRequest('https://app.example/api/comments', 'POST', { taskId: 'task-1', authorId: 'attacker', body: 'Готово' }));

    expect(response.status).toBe(201);
    expect(taskStore.createComment).toHaveBeenCalledWith(actor.workspaceId, { taskId: 'task-1', authorId: actor.membershipId, body: 'Готово' }, actor.userId);
  });
});
