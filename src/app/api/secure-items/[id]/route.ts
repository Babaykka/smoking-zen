import { z } from 'zod';

import { ConflictError } from '@/data/workspace-repository';
import { createSecureItemPatchSchema } from '@/domain/schemas';
import { ServerConfigurationError } from '@/server/env';
import {
  createDefaultSecureItemRouteDependencies,
  publicSecureItemSummary,
  SecureItemNotFoundError,
  type SecureItemRouteDependencies,
} from '@/server/secure-item-api';
import { apiResponse, hasSameOrigin, readJsonObject, restoreErrorResponse } from '@/server/http';

type RouteContext = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const expectedVersionSchema = z.number().int().positive();
const deleteSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();
const restoreSchema = z.object({ action: z.literal('restore'), expectedVersion: expectedVersionSchema }).strict();
const MAX_SAFE_ITEM_JSON_BYTES = 24 * 1024;

export function createSecureItemHandler(dependencies: SecureItemRouteDependencies) {
  const updateSchema = z.object({
    input: createSecureItemPatchSchema(dependencies.selfHostedOrigins),
    expectedVersion: expectedVersionSchema,
  }).strict();
  return async function secureItemHandler(request: Request, context: RouteContext): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'PATCH' && request.method !== 'DELETE') {
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    }
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const { id } = await context.params;
    if (!UUID.test(id)) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный идентификатор записи.' });

    try {
      const body = await readJsonObject(request, MAX_SAFE_ITEM_JSON_BYTES);
      if (request.method === 'PATCH') {
        const restore = restoreSchema.safeParse(body);
        if (restore.success) {
          const restored = await dependencies.store.restoreSecureItem(
            actor.workspaceId, id, restore.data.expectedVersion, actor.userId,
          );
          return apiResponse(requestId, 200, publicSecureItemSummary(restored), null);
        }
        const parsed = updateSchema.safeParse(body);
        if (!parsed.success || Object.keys(parsed.data.input).length === 0) {
          return apiResponse(requestId, 400, null, { code: 'invalid_request', message: parsed.success ? 'Укажите изменения.' : parsed.error.issues[0]?.message ?? 'Некорректный запрос.' });
        }
        const updated = await dependencies.store.updateSecureItem(
          actor.workspaceId, id, parsed.data.input, parsed.data.expectedVersion, actor.userId,
        );
        return apiResponse(requestId, 200, publicSecureItemSummary(updated), null);
      }
      const parsed = deleteSchema.safeParse(body);
      if (!parsed.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
      const deleted = await dependencies.store.deleteSecureItem(actor.workspaceId, id, parsed.data.expectedVersion, actor.userId);
      return apiResponse(requestId, 200, publicSecureItemSummary(deleted), null);
    } catch (error) {
      if (error instanceof ConflictError) return apiResponse(requestId, 409, { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion }, { code: 'version_conflict', message: error.message });
      if (error instanceof SecureItemNotFoundError) return apiResponse(requestId, 404, null, { code: 'record_not_found', message: error.message });
      const recovery = restoreErrorResponse(requestId, error);
      if (recovery) return recovery;
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

async function dispatch(request: Request, context: RouteContext) {
  try {
    return await createSecureItemHandler(createDefaultSecureItemRouteDependencies())(request, context);
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
