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

type TelegramSessionDependencies = {
  appOrigin: string;
  botToken: string;
  ownerTelegramId: string;
  workspaceName?: string;
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

export function createTelegramSessionHandler(dependencies: TelegramSessionDependencies) {
  return async function telegramSessionHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (!hasSameOrigin(request, dependencies.appOrigin)) {
      return apiResponse(requestId, 403, null, { code: 'origin_denied', message: 'Запрос отклонён.' });
    }
    const body = await readJsonObject(request);
    if (
      !body || typeof body.initData !== 'string' || body.initData.length === 0 || body.initData.length > 16_384
      || Object.keys(body).some((key) => key !== 'initData')
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
      if (!await dependencies.store.consumeTelegramSessionAttempt(telegramUser.id)) {
        return apiResponse(requestId, 429, null, {
          code: 'rate_limited',
          message: 'Слишком много попыток. Повторите позже.',
        });
      }
      const membership = telegramUser.launchIntent?.kind === 'invite'
        ? await dependencies.store.redeemInvitation({
          tokenHash: createHash('sha256').update(telegramUser.launchIntent.token, 'utf8').digest('hex'),
          telegramUser,
        })
        : await dependencies.store.bootstrapTelegramUser({
          telegramUser,
          ownerTelegramId: dependencies.ownerTelegramId,
          workspaceName: dependencies.workspaceName ?? 'Smoking Zen',
        });
      if (!membership || !membership.active) {
        return apiResponse(requestId, 403, null, {
          code: 'membership_inactive',
          message: 'Доступ к рабочему пространству отключён.',
        });
      }

      let launch: { kind: 'task'; taskId: string } | null = null;
      if (telegramUser.launchIntent?.kind === 'task') {
        const authorized = await dependencies.store.getAuthorizedTaskLaunch(
          membership.userId,
          membership.workspaceId,
          membership.membershipId,
          telegramUser.launchIntent.taskId,
        );
        if (!authorized) {
          return apiResponse(requestId, 403, null, {
            code: 'launch_unavailable',
            message: 'Задача недоступна.',
          });
        }
        launch = { kind: 'task', taskId: authorized.taskId };
      }

      const cookie = await dependencies.createSession(sessionIdentity(telegramUser, membership));
      const response = apiResponse(requestId, 200, { membership, launch }, null);
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

function defaultDependencies(): TelegramSessionDependencies {
  const environment = requireProductionEnvironment();
  const store = createSupabaseAccessStore(createServiceSupabaseClient(environment));
  return {
    appOrigin: environment.appOrigin,
    botToken: environment.telegramBotToken,
    ownerTelegramId: environment.ownerTelegramId,
    workspaceName: environment.workspaceName,
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
    return await createTelegramSessionHandler(defaultDependencies())(request);
  } catch (error) {
    const requestId = randomUUID();
    if (error instanceof ServerConfigurationError) {
      return apiResponse(requestId, 503, null, { code: 'service_unavailable', message: 'Сервис временно недоступен.' });
    }
    return apiResponse(requestId, 500, null, { code: 'internal_error', message: 'Не удалось выполнить запрос.' });
  }
}
