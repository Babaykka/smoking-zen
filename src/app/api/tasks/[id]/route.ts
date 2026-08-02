import { z } from 'zod';

import { ConflictError } from '@/data/workspace-repository';
import { taskPatchSchema } from '@/domain/schemas';
import { ServerConfigurationError } from '@/server/env';
import { apiResponse, hasSameOrigin, readJsonObject, restoreErrorResponse, WORKSPACE_MAX_JSON_BYTES } from '@/server/http';
import { createDefaultTaskRouteDependencies, type TaskRouteDependencies } from '@/server/task-api';

type RouteContext = { params: Promise<{ id: string }> };
const expectedVersionSchema = z.number().int().positive();
const updateSchema = z.object({ input: taskPatchSchema, expectedVersion: expectedVersionSchema }).strict();
const restoreSchema = z.object({ action: z.literal('restore'), expectedVersion: expectedVersionSchema }).strict();
const deleteSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();

export function createTaskItemHandler(dependencies: TaskRouteDependencies) {
  return async function taskItemHandler(request: Request, context: RouteContext): Promise<Response> {
    const requestId = dependencies.requestId();
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const { id } = await context.params;
    if (!id || id.length > 200) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });

    try {
      const body = await readJsonObject(request, WORKSPACE_MAX_JSON_BYTES);
      if (request.method === 'PATCH') {
        const restore = restoreSchema.safeParse(body);
        if (restore.success) return apiResponse(requestId, 200, await dependencies.store.restoreTask(actor.workspaceId, id, restore.data.expectedVersion, actor.userId), null);
        const update = updateSchema.safeParse(body);
        if (!update.success || Object.keys(update.data.input).length === 0) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
        return apiResponse(requestId, 200, await dependencies.store.updateTask(actor.workspaceId, id, update.data.input, update.data.expectedVersion, actor.userId), null);
      }
      if (request.method === 'DELETE') {
        const parsed = deleteSchema.safeParse(body);
        if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
        return apiResponse(requestId, 200, await dependencies.store.deleteTask(actor.workspaceId, id, parsed.data.expectedVersion, actor.userId), null);
      }
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    } catch (error) {
      if (error instanceof ConflictError) return apiResponse(requestId, 409, { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion }, { code: 'version_conflict', message: error.message });
      const restoreResponse = restoreErrorResponse(requestId, error);
      if (restoreResponse) return restoreResponse;
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

async function dispatch(request: Request, context: RouteContext) {
  try {
    return await createTaskItemHandler(createDefaultTaskRouteDependencies())(request, context);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось выполнить запрос.',
    });
  }
}

export const PATCH = dispatch;
export const DELETE = dispatch;
