import { randomUUID } from 'node:crypto';

import { runCleanupCycle, type CleanupCycleResult } from '@/server/cleanup/coordinator';
import { createSupabaseCleanupBackend } from '@/server/cleanup/supabase-cleanup-backend';
import { ServerConfigurationError, requireProductionEnvironment } from '@/server/env';
import { apiResponse, readJsonObject } from '@/server/http';
import { hasTimingSafeBearer } from '@/server/internal-auth';
import { createServiceSupabaseClient } from '@/server/supabase';

const MAXIMUM_BODY_BYTES = 64;

type CleanupDependencies = {
  secret: string;
  requestId(): string;
  run(): Promise<CleanupCycleResult>;
};

export function createCleanupHandler(dependencies: CleanupDependencies) {
  return async function cleanupHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') {
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    }
    if (!hasTimingSafeBearer(request, dependencies.secret)) {
      return apiResponse(requestId, 401, null, { code: 'authentication_failed', message: 'Запрос отклонён.' });
    }
    const body = await readJsonObject(request, MAXIMUM_BODY_BYTES);
    if (!body || Object.keys(body).length !== 0) {
      return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
    }
    try {
      return apiResponse(requestId, 200, await dependencies.run(), null);
    } catch {
      return apiResponse(requestId, 503, null, {
        code: 'cleanup_unavailable', message: 'Сервис очистки временно недоступен.',
      });
    }
  };
}

function defaultDependencies(): CleanupDependencies {
  const environment = requireProductionEnvironment();
  return {
    secret: environment.internalJobSecret,
    requestId: () => randomUUID(),
    run: () => runCleanupCycle(createSupabaseCleanupBackend(createServiceSupabaseClient(environment))),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createCleanupHandler(defaultDependencies())(request);
  } catch (error) {
    return apiResponse(randomUUID(), error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось выполнить запрос.',
    });
  }
}
