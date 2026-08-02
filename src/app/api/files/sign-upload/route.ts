import { z } from 'zod';

import { FileValidationError, validateUpload } from '@/domain/files';
import { ServerConfigurationError } from '@/server/env';
import { createDefaultFileRouteDependencies, type FileRouteDependencies } from '@/server/files/file-api';
import { FileOperationError, ParentNotFoundError } from '@/server/files/file-store';
import { apiResponse, hasSameOrigin, readJsonObject } from '@/server/http';

const MAX_PREFLIGHT_JSON_BYTES = 32 * 1024;
const MAX_HEADER_BYTES = 8_192;

const signUploadSchema = z.object({
  parentType: z.enum(['task', 'knowledge']),
  parentId: z.string().uuid(),
  name: z.string().min(1).max(1_024),
  declaredMime: z.string().min(1).max(200),
  size: z.number().int().positive(),
  headerBase64: z.string().min(1).max(Math.ceil(MAX_HEADER_BYTES / 3) * 4 + 4),
}).strict();

function decodeBase64(value: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.length <= MAX_HEADER_BYTES ? decoded : null;
}

export function createSignUploadHandler(dependencies: FileRouteDependencies) {
  return async function signUploadHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });

    try {
      try {
        await dependencies.store.cleanupExpiredUploads(new Date(), 20);
      } catch {
        // Cleanup is opportunistic; signing remains available and the next request retries it.
      }
      const body = await readJsonObject(request, MAX_PREFLIGHT_JSON_BYTES);
      const parsed = signUploadSchema.safeParse(body);
      if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректные данные файла.' });
      const headerBytes = decodeBase64(parsed.data.headerBase64);
      if (!headerBytes) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректные данные файла.' });
      const file = validateUpload({
        name: parsed.data.name,
        declaredMime: parsed.data.declaredMime,
        size: parsed.data.size,
        headerBytes,
      });
      const signed = await dependencies.store.signUpload(actor.workspaceId, actor.userId, {
        parent: { type: parsed.data.parentType, id: parsed.data.parentId },
        file,
      });
      return apiResponse(requestId, 201, signed, null);
    } catch (error) {
      if (error instanceof FileValidationError) return apiResponse(requestId, 400, null, { code: 'file_rejected', message: error.message });
      if (error instanceof ParentNotFoundError) return apiResponse(requestId, 404, null, { code: 'parent_not_found', message: error.message });
      if (error instanceof FileOperationError) return apiResponse(requestId, 503, null, { code: 'file_service_unavailable', message: error.message });
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось подготовить загрузку файла.' });
    }
  };
}

async function dispatch(request: Request) {
  try {
    return await createSignUploadHandler(createDefaultFileRouteDependencies())(request);
  } catch (error) {
    const requestId = crypto.randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось подготовить загрузку файла.',
    });
  }
}

export const POST = dispatch;
