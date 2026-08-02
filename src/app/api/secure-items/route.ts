import { createSecureItemInputSchema } from '@/domain/schemas';
import { ServerConfigurationError } from '@/server/env';
import {
  createDefaultSecureItemRouteDependencies,
  publicSecureItemSummary,
  type SecureItemRouteDependencies,
} from '@/server/secure-item-api';
import { apiResponse, hasSameOrigin, readJsonObject } from '@/server/http';

const MAX_SAFE_ITEM_JSON_BYTES = 24 * 1024;

export function createSecureItemsHandler(dependencies: SecureItemRouteDependencies) {
  const inputSchema = createSecureItemInputSchema(dependencies.selfHostedOrigins);
  return async function secureItemsHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });

    try {
      if (request.method === 'GET') {
        const items = await dependencies.store.listSecureItems(actor.workspaceId);
        return apiResponse(requestId, 200, items.map(publicSecureItemSummary), null);
      }
      if (request.method !== 'POST') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
      if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
      const body = await readJsonObject(request, MAX_SAFE_ITEM_JSON_BYTES);
      const parsed = inputSchema.safeParse(body);
      if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Некорректный запрос.' });
      const created = await dependencies.store.createSecureItem(actor.workspaceId, parsed.data, actor.userId);
      return apiResponse(requestId, 201, publicSecureItemSummary(created), null);
    } catch {
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

async function dispatch(request: Request) {
  try {
    return await createSecureItemsHandler(createDefaultSecureItemRouteDependencies())(request);
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
