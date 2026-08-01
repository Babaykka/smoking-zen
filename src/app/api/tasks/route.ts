import { ConflictError } from '@/data/workspace-repository';
import { taskInputSchema } from '@/domain/schemas';
import { ServerConfigurationError } from '@/server/env';
import { apiResponse, hasSameOrigin, readJsonObject } from '@/server/http';
import { createDefaultTaskRouteDependencies, type TaskRouteDependencies } from '@/server/task-api';

export function createTasksHandler(dependencies: TaskRouteDependencies) {
  return async function tasksHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });

    try {
      if (request.method === 'GET') {
        return apiResponse(requestId, 200, await dependencies.store.getWorkspaceData(actor.workspaceId), null);
      }
      if (request.method !== 'POST') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
      if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
      const body = await readJsonObject(request);
      const parsed = taskInputSchema.safeParse(body);
      if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Некорректный запрос.' });
      const task = await dependencies.store.createTask(actor.workspaceId, parsed.data, actor.userId);
      return apiResponse(requestId, 201, task, null);
    } catch (error) {
      if (error instanceof ConflictError) return apiResponse(requestId, 409, { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion }, { code: 'version_conflict', message: error.message });
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

async function dispatch(request: Request) {
  try {
    return await createTasksHandler(createDefaultTaskRouteDependencies())(request);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось выполнить запрос.',
    });
  }
}

export const GET = dispatch;
export const POST = dispatch;
