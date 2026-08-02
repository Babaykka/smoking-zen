import { z } from 'zod';

import { ConflictError } from '@/data/workspace-repository';
import { knowledgePatchSchema } from '@/domain/schemas';
import { ServerConfigurationError } from '@/server/env';
import { apiResponse, hasSameOrigin, readJsonObject } from '@/server/http';
import { createDefaultKnowledgeContactRouteDependencies, type KnowledgeContactRouteDependencies } from '@/server/knowledge-contact-api';

type RouteContext = { params: Promise<{ id: string }> };
const expectedVersionSchema = z.number().int().positive();
const updateSchema = z.object({ input: knowledgePatchSchema, expectedVersion: expectedVersionSchema }).strict();
const restoreSchema = z.object({ action: z.literal('restore'), expectedVersion: expectedVersionSchema }).strict();
const deleteSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();

export function createKnowledgeItemHandler(dependencies: KnowledgeContactRouteDependencies) {
  return async function knowledgeItemHandler(request: Request, context: RouteContext): Promise<Response> {
    const requestId = dependencies.requestId();
    if (!hasSameOrigin(request, dependencies.appOrigin)) return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    const { id } = await context.params;
    if (!id || id.length > 200) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
    const body = await readJsonObject(request);
    try {
      if (request.method === 'PATCH') {
        const restore = restoreSchema.safeParse(body);
        if (restore.success) return apiResponse(requestId, 200, await dependencies.store.restoreKnowledge(actor.workspaceId, id, restore.data.expectedVersion, actor.userId), null);
        const update = updateSchema.safeParse(body);
        if (!update.success || Object.keys(update.data.input).length === 0) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
        return apiResponse(requestId, 200, await dependencies.store.updateKnowledge(actor.workspaceId, id, update.data.input, update.data.expectedVersion, actor.userId), null);
      }
      if (request.method === 'DELETE') {
        const deleted = deleteSchema.safeParse(body);
        if (!deleted.success) return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
        return apiResponse(requestId, 200, await dependencies.store.deleteKnowledge(actor.workspaceId, id, deleted.data.expectedVersion, actor.userId), null);
      }
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    } catch (error) {
      if (error instanceof ConflictError) return apiResponse(requestId, 409, { expectedVersion: error.expectedVersion, actualVersion: error.actualVersion }, { code: 'version_conflict', message: error.message });
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

async function dispatch(request: Request, context: RouteContext) {
  try {
    return await createKnowledgeItemHandler(createDefaultKnowledgeContactRouteDependencies())(request, context);
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
