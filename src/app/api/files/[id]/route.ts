import { z } from 'zod';

import { ServerConfigurationError } from '@/server/env';
import { createDefaultFileRouteDependencies, type FileRouteDependencies } from '@/server/files/file-api';
import { FileMutationError, FileOperationError } from '@/server/files/file-store';
import { apiResponse, hasSameOrigin, readJsonObject } from '@/server/http';

type RouteContext = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const archiveSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const restoreSchema = archiveSchema.extend({ action: z.literal('restore') }).strict();

export function createFileMutationHandler(dependencies: FileRouteDependencies) {
  return async function fileMutationHandler(request: Request, context: RouteContext): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'DELETE' && request.method !== 'PATCH') {
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    }
    if (!hasSameOrigin(request, dependencies.appOrigin)) {
      return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    }
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const { id } = await context.params;
    if (!UUID.test(id)) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный идентификатор файла.' });
    const body = await readJsonObject(request, 2_048);
    const parsed = request.method === 'DELETE' ? archiveSchema.safeParse(body) : restoreSchema.safeParse(body);
    if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректная версия файла.' });

    try {
      const data = request.method === 'DELETE'
        ? await dependencies.store.archiveAttachment(actor.workspaceId, id, parsed.data.expectedVersion)
        : await dependencies.store.restoreAttachment(actor.workspaceId, id, parsed.data.expectedVersion);
      return apiResponse(requestId, 200, data, null);
    } catch (error) {
      if (error instanceof FileMutationError) {
        if (error.code === 'version_conflict') {
          return apiResponse(requestId, 409, {
            expectedVersion: error.expectedVersion, actualVersion: error.actualVersion,
          }, { code: 'version_conflict', message: 'Файл был изменён другим участником.' });
        }
        if (error.code === 'restore_expired') return apiResponse(requestId, 410, null, { code: error.code, message: 'Срок восстановления файла истёк.' });
        if (error.code === 'file_not_found') return apiResponse(requestId, 404, null, { code: error.code, message: 'Файл не найден.' });
        if (error.code === 'parent_not_found') return apiResponse(requestId, 409, null, { code: error.code, message: 'Сначала восстановите запись файла.' });
        return apiResponse(requestId, 409, null, { code: error.code, message: 'Операция с файлом недоступна.' });
      }
      if (error instanceof FileOperationError) return apiResponse(requestId, 503, null, { code: 'file_service_unavailable', message: error.message });
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось изменить файл.' });
    }
  };
}

async function dispatch(request: Request, context: RouteContext) {
  try {
    return await createFileMutationHandler(createDefaultFileRouteDependencies())(request, context);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось изменить файл.',
    });
  }
}

export const DELETE = dispatch;
export const PATCH = dispatch;
