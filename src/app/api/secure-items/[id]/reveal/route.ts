import { ServerConfigurationError } from '@/server/env';
import {
  createDefaultSecureItemRouteDependencies,
  SecureItemNotFoundError,
  type SecureItemRouteDependencies,
} from '@/server/secure-item-api';
import { apiResponse, hasSameOrigin } from '@/server/http';

type RouteContext = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createSecureItemRevealHandler(dependencies: SecureItemRouteDependencies) {
  return async function secureItemRevealHandler(request: Request, context: RouteContext): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const { id } = await context.params;
    if (!UUID.test(id)) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный идентификатор записи.' });

    try {
      return apiResponse(requestId, 200, await dependencies.store.revealSecureItem(actor.workspaceId, id), null);
    } catch (error) {
      if (error instanceof SecureItemNotFoundError) return apiResponse(requestId, 404, null, { code: 'record_not_found', message: error.message });
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось открыть ссылку Bitwarden.' });
    }
  };
}

async function dispatch(request: Request, context: RouteContext) {
  try {
    return await createSecureItemRevealHandler(createDefaultSecureItemRouteDependencies())(request, context);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось открыть ссылку Bitwarden.',
    });
  }
}

export const POST = dispatch;
