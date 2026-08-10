import { randomUUID } from 'node:crypto';

import { apiResponse, hasSameOrigin, readSessionCookie, setSessionCookie } from '@/server/http';
import { requireProductionEnvironment, ServerConfigurationError } from '@/server/env';
import { clearSession, readSession, refreshSession, type SessionCookie, type SessionIdentity } from '@/server/session';
import {
  createServiceSupabaseClient,
  createSupabaseAccessStore,
  type AccessStore,
} from '@/server/supabase';

type RefreshDependencies = {
  appOrigin: string;
  store: AccessStore;
  requestId: () => string;
  readSession: (value: string | undefined) => Promise<SessionIdentity | null>;
  refreshSession: (value: string | undefined) => Promise<SessionCookie | null>;
  clearSession: () => SessionCookie;
};

export function createRefreshSessionHandler(dependencies: RefreshDependencies) {
  return async function refreshSessionHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') {
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    }
    if (!hasSameOrigin(request, dependencies.appOrigin)) {
      return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    }

    try {
      const token = readSessionCookie(request);
      const identity = await dependencies.readSession(token);
      if (!identity) {
        const response = apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
        setSessionCookie(response, dependencies.clearSession());
        return response;
      }

      const membership = await dependencies.store.getActiveMembership(identity.userId, identity.workspaceId);
      if (!membership?.active || membership.membershipId !== identity.membershipId || membership.role !== identity.role) {
        const response = apiResponse(requestId, 403, null, {
          code: 'membership_inactive',
          message: 'Доступ к рабочему пространству отключён.',
        });
        setSessionCookie(response, dependencies.clearSession());
        return response;
      }

      const cookie = await dependencies.refreshSession(token);
      if (!cookie) {
        const response = apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
        setSessionCookie(response, dependencies.clearSession());
        return response;
      }
      const response = apiResponse(requestId, 200, { membership }, null);
      setSessionCookie(response, cookie);
      return response;
    } catch {
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

function defaultDependencies(): RefreshDependencies {
  const environment = requireProductionEnvironment();
  const store = createSupabaseAccessStore(createServiceSupabaseClient(environment));
  return {
    appOrigin: environment.appOrigin,
    store,
    requestId: () => randomUUID(),
    readSession: (value) => readSession(value, { secret: environment.sessionSecret }),
    refreshSession: (value) => refreshSession(value, {
      secret: environment.sessionSecret,
      secure: environment.production,
    }),
    clearSession: () => clearSession({ secure: environment.production }),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createRefreshSessionHandler(defaultDependencies())(request);
  } catch (error) {
    const requestId = randomUUID();
    if (error instanceof ServerConfigurationError) {
      return apiResponse(requestId, 503, null, { code: 'service_unavailable', message: 'Сервис временно недоступен.' });
    }
    return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
  }
}
