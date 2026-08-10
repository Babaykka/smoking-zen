import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { apiResponse, hasSameOrigin, readJsonObject, readSessionCookie } from '@/server/http';
import { requireProductionEnvironment, ServerConfigurationError } from '@/server/env';
import { readSession, type SessionIdentity } from '@/server/session';
import {
  createServiceSupabaseClient,
  createSupabaseAccessStore,
  type AccessStore,
} from '@/server/supabase';
import { buildInviteDeepLink } from '@/server/notifications/policy';

type SessionActor = Pick<SessionIdentity, 'userId' | 'workspaceId' | 'membershipId' | 'role'>;

type InviteDependencies = {
  appOrigin: string;
  botUsername: string;
  appShortName: string;
  store: AccessStore;
  now: () => Date;
  requestId: () => string;
  readSession: (value: string | undefined) => Promise<SessionActor | null>;
  generateToken: () => string;
};

export function createInviteHandler(dependencies: InviteDependencies) {
  return async function inviteHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') {
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    }
    if (!hasSameOrigin(request, dependencies.appOrigin)) {
      return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    }

    const body = await readJsonObject(request);
    if (!body || body.role !== 'member' || Object.keys(body).some((key) => key !== 'role')) {
      return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
    }

    try {
      const actor = await dependencies.readSession(readSessionCookie(request));
      if (!actor) {
        return apiResponse(requestId, 401, null, { code: 'session_invalid', message: 'Требуется авторизация.' });
      }
      const membership = await dependencies.store.getActiveMembership(actor.userId, actor.workspaceId);
      if (!membership?.active || membership.membershipId !== actor.membershipId || membership.role !== 'owner') {
        return apiResponse(requestId, 403, null, { code: 'owner_required', message: 'Недостаточно прав.' });
      }

      const now = dependencies.now();
      const token = dependencies.generateToken();
      const inviteLink = buildInviteDeepLink(dependencies.botUsername, dependencies.appShortName, token);
      const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString();
      const invitation = await dependencies.store.createInvitation({
        workspaceId: membership.workspaceId,
        creatorUserId: membership.userId,
        role: 'member',
        tokenHash,
        expiresAt,
      });
      return apiResponse(requestId, 201, {
        invitationId: invitation.id,
        inviteLink,
        expiresAt: invitation.expiresAt,
      }, null);
    } catch {
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

function defaultDependencies(): InviteDependencies {
  const environment = requireProductionEnvironment();
  const store = createSupabaseAccessStore(createServiceSupabaseClient(environment));
  return {
    appOrigin: environment.appOrigin,
    botUsername: environment.telegramBotUsername,
    appShortName: environment.telegramMiniAppShortName,
    store,
    now: () => new Date(),
    requestId: () => randomUUID(),
    readSession: (value) => readSession(value, { secret: environment.sessionSecret }),
    generateToken: () => randomBytes(32).toString('base64url'),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createInviteHandler(defaultDependencies())(request);
  } catch (error) {
    const requestId = randomUUID();
    if (error instanceof ServerConfigurationError) {
      return apiResponse(requestId, 503, null, { code: 'service_unavailable', message: 'Сервис временно недоступен.' });
    }
    return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
  }
}
