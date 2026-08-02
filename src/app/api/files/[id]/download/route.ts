import { ServerConfigurationError } from '@/server/env';
import { createDefaultFileRouteDependencies, type FileRouteDependencies } from '@/server/files/file-api';
import {
  FileNotFoundError,
  FileNotReadyError,
  FileOperationError,
  SIGNED_DOWNLOAD_SECONDS,
} from '@/server/files/file-store';
import { apiResponse, hasSameOrigin } from '@/server/http';

type RouteContext = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function hasSameOriginReadContext(request: Request, expectedOrigin: string): boolean {
  if (request.headers.has('origin')) return hasSameOrigin(request, expectedOrigin);
  if (request.headers.get('sec-fetch-site') === 'same-origin') return true;
  const referer = request.headers.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

export function createFileDownloadHandler(dependencies: FileRouteDependencies) {
  return async function fileDownloadHandler(request: Request, context: RouteContext): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'GET') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    if (!hasSameOriginReadContext(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const { id } = await context.params;
    if (!UUID.test(id)) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный идентификатор файла.' });

    try {
      const signed = await dependencies.store.signDownload(actor.workspaceId, id, SIGNED_DOWNLOAD_SECONDS);
      return apiResponse(requestId, 200, signed, null);
    } catch (error) {
      if (error instanceof FileNotFoundError) return apiResponse(requestId, 404, null, { code: 'file_not_found', message: error.message });
      if (error instanceof FileNotReadyError) return apiResponse(requestId, 409, null, { code: 'file_not_ready', message: error.message });
      if (error instanceof FileOperationError) return apiResponse(requestId, 503, null, { code: 'file_service_unavailable', message: error.message });
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось подготовить скачивание файла.' });
    }
  };
}

async function dispatch(request: Request, context: RouteContext) {
  try {
    return await createFileDownloadHandler(createDefaultFileRouteDependencies())(request, context);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось подготовить скачивание файла.',
    });
  }
}

export const GET = dispatch;
