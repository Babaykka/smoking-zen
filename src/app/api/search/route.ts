import { z } from 'zod';

import { ServerConfigurationError } from '@/server/env';
import { apiResponse, hasSameOrigin, readJsonObject } from '@/server/http';
import { createDefaultKnowledgeContactRouteDependencies, type KnowledgeContactRouteDependencies } from '@/server/knowledge-contact-api';

const searchSchema = z.object({ query: z.string().trim().min(1, 'Введите поисковый запрос.').max(120, 'Поисковый запрос слишком длинный.') }).strict();

export function createSearchHandler(dependencies: KnowledgeContactRouteDependencies) {
  return async function searchHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const parsed = searchSchema.safeParse(await readJsonObject(request));
    if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Некорректный запрос.' });
    try {
      return apiResponse(requestId, 200, await dependencies.store.search(actor.workspaceId, parsed.data.query), null);
    } catch {
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Поиск временно недоступен.' });
    }
  };
}

async function dispatch(request: Request) {
  try {
    return await createSearchHandler(createDefaultKnowledgeContactRouteDependencies())(request);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Поиск временно недоступен.',
    });
  }
}

export const POST = dispatch;
