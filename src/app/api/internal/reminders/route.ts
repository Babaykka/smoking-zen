import { randomUUID } from 'node:crypto';

import { ServerConfigurationError, requireProductionEnvironment } from '@/server/env';
import { apiResponse, readJsonObject } from '@/server/http';
import { hasTimingSafeBearer } from '@/server/internal-auth';
import { createSupabaseNotificationStore } from '@/server/notifications/supabase-store';
import { createTelegramClient } from '@/server/notifications/telegram-client';
import { runNotificationCycle, type NotificationCycleResult } from '@/server/notifications/worker';
import { createServiceSupabaseClient } from '@/server/supabase';

const MAXIMUM_BODY_BYTES = 64;

type ReminderDependencies = {
  secret: string;
  requestId(): string;
  run(): Promise<NotificationCycleResult>;
};

export function createReminderHandler(dependencies: ReminderDependencies) {
  return async function reminderHandler(request: Request): Promise<Response> {
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
      const result = await dependencies.run();
      if (result.indeterminate > 0) {
        return apiResponse(requestId, 503, result, {
          code: 'delivery_indeterminate',
          message: 'Результат части доставок требует проверки.',
        });
      }
      return apiResponse(requestId, 200, result, null);
    } catch {
      return apiResponse(requestId, 503, null, {
        code: 'notification_unavailable',
        message: 'Сервис уведомлений временно недоступен.',
      });
    }
  };
}

function defaultDependencies(): ReminderDependencies {
  const environment = requireProductionEnvironment();
  const client = createServiceSupabaseClient(environment);
  return {
    secret: environment.internalJobSecret,
    requestId: () => randomUUID(),
    run: () => runNotificationCycle({
      store: createSupabaseNotificationStore(client),
      telegram: createTelegramClient({ token: environment.telegramBotToken }),
      botUsername: environment.telegramBotUsername,
      appShortName: environment.telegramMiniAppShortName,
    }),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createReminderHandler(defaultDependencies())(request);
  } catch (error) {
    return apiResponse(randomUUID(), error instanceof ServerConfigurationError ? 503 : 500, null, {
      code: error instanceof ServerConfigurationError ? 'service_unavailable' : 'internal_error',
      message: error instanceof ServerConfigurationError ? 'Сервис временно недоступен.' : 'Не удалось выполнить запрос.',
    });
  }
}
