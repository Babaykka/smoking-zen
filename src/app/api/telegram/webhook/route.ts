import { randomUUID } from 'node:crypto';

import { ServerConfigurationError, requireProductionEnvironment } from '@/server/env';
import { apiResponse, readJsonObject } from '@/server/http';
import { timingSafeSecretMatches } from '@/server/internal-auth';
import { createSupabaseWebhookStore, type TelegramWebhookStore } from '@/server/notifications/supabase-store';
import { createServiceSupabaseClient } from '@/server/supabase';

const MAXIMUM_WEBHOOK_BYTES = 16 * 1_024;

type WebhookDependencies = {
  secret: string;
  requestId(): string;
  store: TelegramWebhookStore;
};

function validMessageEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (!Number.isSafeInteger(message.message_id) || Number(message.message_id) < 0) return false;
  if (!Number.isSafeInteger(message.date) || Number(message.date) < 0) return false;
  if (message.text !== undefined && (typeof message.text !== 'string' || message.text.length > 4_096)) return false;
  if (!message.chat || typeof message.chat !== 'object' || Array.isArray(message.chat)) return false;
  const chat = message.chat as Record<string, unknown>;
  return ['private', 'group', 'supergroup', 'channel'].includes(String(chat.type))
    && Number.isSafeInteger(chat.id) && Number(chat.id) !== 0;
}

function parseUpdate(body: Record<string, unknown> | null): bigint | null {
  if (!body || !Number.isSafeInteger(body.update_id) || Number(body.update_id) < 0) return null;
  if (body.message !== undefined && !validMessageEnvelope(body.message)) return null;
  return BigInt(Number(body.update_id));
}

export function createTelegramWebhookHandler(dependencies: WebhookDependencies) {
  return async function telegramWebhookHandler(request: Request): Promise<Response> {
    const requestId = dependencies.requestId();
    if (request.method !== 'POST') {
      return apiResponse(requestId, 405, null, { code: 'method_not_allowed', message: 'Метод не поддерживается.' });
    }
    if (!timingSafeSecretMatches(
      request.headers.get('x-telegram-bot-api-secret-token'),
      dependencies.secret,
    )) {
      return apiResponse(requestId, 401, null, { code: 'authentication_failed', message: 'Запрос отклонён.' });
    }

    const updateId = parseUpdate(await readJsonObject(request, MAXIMUM_WEBHOOK_BYTES));
    if (updateId === null) {
      return apiResponse(requestId, 400, null, { code: 'invalid_update', message: 'Некорректное обновление.' });
    }

    try {
      await dependencies.store.recordUpdate(updateId);
      return apiResponse(requestId, 200, { accepted: true }, null);
    } catch {
      return apiResponse(requestId, 503, null, {
        code: 'webhook_unavailable',
        message: 'Сервис временно недоступен.',
      });
    }
  };
}

function defaultDependencies(): WebhookDependencies {
  const environment = requireProductionEnvironment();
  return {
    secret: environment.telegramWebhookSecret,
    requestId: () => randomUUID(),
    store: createSupabaseWebhookStore(createServiceSupabaseClient(environment)),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createTelegramWebhookHandler(defaultDependencies())(request);
  } catch (error) {
    return apiResponse(randomUUID(), error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: 'Сервис временно недоступен.',
    });
  }
}
