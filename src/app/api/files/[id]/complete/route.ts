import { FileValidationError } from '@/domain/files';
import { ServerConfigurationError } from '@/server/env';
import { createDefaultFileRouteDependencies, type FileRouteDependencies } from '@/server/files/file-api';
import {
  FileNotFoundError,
  FileOperationError,
  ParentNotFoundError,
  UploadExpiredError,
  UploadValidationBusyError,
} from '@/server/files/file-store';
import { apiResponse, hasSameOrigin } from '@/server/http';

type RouteContext = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createFileCompletionHandler(dependencies: FileRouteDependencies) {
  return async function fileCompletionHandler(request: Request, context: RouteContext): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const { id } = await context.params;
    if (!UUID.test(id)) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный идентификатор файла.' });

    try {
      return apiResponse(requestId, 200, await dependencies.store.completeUpload(actor.workspaceId, id), null);
    } catch (error) {
      if (error instanceof FileValidationError) return apiResponse(requestId, 422, null, { code: 'file_rejected', message: error.message });
      if (error instanceof FileNotFoundError) return apiResponse(requestId, 404, null, { code: 'file_not_found', message: error.message });
      if (error instanceof ParentNotFoundError) return apiResponse(requestId, 404, null, { code: 'parent_not_found', message: error.message });
      if (error instanceof UploadExpiredError) return apiResponse(requestId, 410, null, { code: 'upload_expired', message: error.message });
      if (error instanceof UploadValidationBusyError) return apiResponse(requestId, 409, null, { code: 'upload_processing', message: error.message });
      if (error instanceof FileOperationError) return apiResponse(requestId, 503, null, { code: 'file_service_unavailable', message: error.message });
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось завершить загрузку файла.' });
    }
  };
}

async function dispatch(request: Request, context: RouteContext) {
  try {
    return await createFileCompletionHandler(createDefaultFileRouteDependencies())(request, context);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось завершить загрузку файла.',
    });
  }
}

export const POST = dispatch;
