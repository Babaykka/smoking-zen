import { commentInputSchema } from '@/domain/schemas';
import { ServerConfigurationError } from '@/server/env';
import { apiResponse, hasSameOrigin, readJsonObject, WORKSPACE_MAX_JSON_BYTES } from '@/server/http';
import { createDefaultTaskRouteDependencies, type TaskRouteDependencies } from '@/server/task-api';

export function createCommentsHandler(dependencies: TaskRouteDependencies) {
  return async function commentsHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const body = await readJsonObject(request, WORKSPACE_MAX_JSON_BYTES);
    const parsed = commentInputSchema.safeParse(body && { ...body, authorId: actor.membershipId });
    if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Некорректный запрос.' });
    try {
      return apiResponse(requestId, 201, await dependencies.store.createComment(actor.workspaceId, parsed.data, actor.userId), null);
    } catch {
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

export async function POST(request: Request) {
  try {
    return await createCommentsHandler(createDefaultTaskRouteDependencies())(request);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось выполнить запрос.',
    });
  }
}
