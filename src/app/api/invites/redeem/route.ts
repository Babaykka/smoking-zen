import { createHash, randomUUID } from 'node:crypto';

import { apiResponse, hasSameOrigin, readJsonObject, setSessionCookie } from '@/server/http';
import { requireProductionEnvironment, ServerConfigurationError } from '@/server/env';
import { createSession, type SessionCookie, type SessionIdentity } from '@/server/session';
import {
  createServiceSupabaseClient,
  createSupabaseAccessStore,
  type AccessStore,
  type MembershipAccess,
} from '@/server/supabase';
import {
  TelegramInitDataError,
  verifyTelegramInitData,
  type VerifiedTelegramUser,
} from '@/server/telegram/verify-init-data';

type RedeemInvitationDependencies = {
  appOrigin: string;
  botToken: string;
  maxAgeSeconds?: number;
  store: AccessStore;
  now: () => Date;
  requestId: () => string;
  verifyInitData: (raw: string, botToken: string, now: Date, maxAgeSeconds: number) => VerifiedTelegramUser;
  createSession: (identity: SessionIdentity) => Promise<SessionCookie>;
};

function sessionIdentity(user: VerifiedTelegramUser, membership: MembershipAccess): SessionIdentity {
  return {
    userId: membership.userId,
    telegramId: user.id,
    workspaceId: membership.workspaceId,
    membershipId: membership.membershipId,
    role: membership.role,
  };
}

function invitationUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['invitation_invalid', 'invitation_used', 'invitation_expired'].includes(String(error.code));
}

export function createRedeemInvitationHandler(dependencies: RedeemInvitationDependencies) {
  return async function redeemInvitationHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (!hasSameOrigin(request, dependencies.appOrigin)) {
      return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    }

    const body = await readJsonObject(request);
    if (
      !body || typeof body.initData !== 'string' || body.initData.length === 0 || body.initData.length > 16_384 ||
      typeof body.token !== 'string' || body.token.length < 32 || body.token.length > 256 ||
      Object.keys(body).some((key) => key !== 'initData' && key !== 'token')
    ) {
      return apiResponse(requestId, 400, null, { code: 'invalid_request', message: 'Некорректный запрос.' });
    }

    try {
      const now = dependencies.now();
      const telegramUser = dependencies.verifyInitData(
        body.initData,
        dependencies.botToken,
        now,
        dependencies.maxAgeSeconds ?? 300,
      );
      const tokenHash = createHash('sha256').update(body.token, 'utf8').digest('hex');
      const membership = await dependencies.store.redeemInvitation({
        tokenHash,
        telegramUser,
      });
      if (!membership.active) {
        return apiResponse(requestId, 403, null, {
          code: 'membership_inactive',
          message: 'Доступ к рабочему пространству отключён.',
        });
      }

      const cookie = await dependencies.createSession(sessionIdentity(telegramUser, membership));
      const response = apiResponse(requestId, 200, { membership }, null);
      setSessionCookie(response, cookie);
      return response;
    } catch (error) {
      if (error instanceof TelegramInitDataError) {
        return apiResponse(requestId, 401, null, { code: 'telegram_invalid', message: 'Авторизация Telegram недействительна.' });
      }
      if (invitationUnavailable(error)) {
        return apiResponse(requestId, 409, null, {
          code: 'invitation_unavailable',
          message: 'Приглашение недействительно или уже использовано.',
        });
      }
      return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
    }
  };
}

function defaultDependencies(): RedeemInvitationDependencies {
  const environment = requireProductionEnvironment();
  const store = createSupabaseAccessStore(createServiceSupabaseClient(environment));
  return {
    appOrigin: environment.appOrigin,
    botToken: environment.telegramBotToken,
    maxAgeSeconds: environment.telegramInitDataMaxAgeSeconds,
    store,
    now: () => new Date(),
    requestId: () => randomUUID(),
    verifyInitData: verifyTelegramInitData,
    createSession: (identity) => createSession(identity, {
      secret: environment.sessionSecret,
      secure: environment.production,
    }),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createRedeemInvitationHandler(defaultDependencies())(request);
  } catch (error) {
    const requestId = randomUUID();
    if (error instanceof ServerConfigurationError) {
      return apiResponse(requestId, 503, null, { code: 'service_unavailable', message: 'Сервис временно недоступен.' });
    }
    return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
  }
}
