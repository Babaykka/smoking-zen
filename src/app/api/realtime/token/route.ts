import { randomUUID } from 'node:crypto';

import { ServerConfigurationError, requireProductionEnvironment } from '@/server/env';
import { apiResponse, readSessionCookie } from '@/server/http';
import { createRealtimeAccessToken } from '@/server/realtime-token';
import { readSession } from '@/server/session';
import { createServiceSupabaseClient, createSupabaseAccessStore } from '@/server/supabase';
import type { TaskSessionActor } from '@/server/task-api';

type RealtimeTokenDependencies = {
  authenticate(request: Request): Promise<TaskSessionActor | null>;
  mint(actor: TaskSessionActor): Promise<string>;
  now(): Date;
  requestId(): string;
};

export function createRealtimeTokenHandler(dependencies: RealtimeTokenDependencies) {
  return async function realtimeTokenHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'GET') return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    const actor = await dependencies.authenticate(request);
    if (!actor) return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
    try {
      const now = dependencies.now();
      const token = await dependencies.mint(actor);
      return apiResponse(requestId, 200, {
        token,
        workspaceId: actor.workspaceId,
        expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      }, null);
    } catch {
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось подключить совместную работу.' });
    }
  };
}

function defaultDependencies(): RealtimeTokenDependencies {
  const environment = requireProductionEnvironment();
  const accessStore = createSupabaseAccessStore(createServiceSupabaseClient(environment));
  const now = () => new Date();
  return {
    now,
    requestId: () => randomUUID(),
    async authenticate(request) {
      const identity = await readSession(readSessionCookie(request), { secret: environment.sessionSecret });
      if (!identity) return null;
      const membership = await accessStore.getActiveMembership(identity.userId, identity.workspaceId);
      if (!membership?.active || membership.membershipId !== identity.membershipId) return null;
      return { userId: identity.userId, workspaceId: identity.workspaceId, membershipId: identity.membershipId };
    },
    mint: (actor) => createRealtimeAccessToken(actor, {
      privateKeyPem: environment.supabaseJwtEs256PrivateKey,
      keyId: environment.supabaseJwtKid,
      issuer: `${environment.supabaseUrl.replace(/\/$/, '')}/auth/v1`,
      now: now(),
    }),
  };
}

export async function GET(request: Request) {
  try {
    return await createRealtimeTokenHandler(defaultDependencies())(request);
  } catch (error) {
    const requestId = randomUUID();
    return apiResponse(requestId, error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось подключить совместную работу.',
    });
  }
}
