import { randomUUID } from 'node:crypto';

import { apiResponse } from '@/server/http';

type RemovedRedeemDependencies = {
  requestId: () => string;
  onEffect?: () => void;
};

export function createRedeemInvitationHandler(dependencies: RemovedRedeemDependencies) {
  return async function removedRedeemInvitationHandler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return apiResponse(dependencies.requestId(), 405, null, {
        code: 'method_not_allowed',
        message: 'Метод не поддерживается.',
      });
    }
    return apiResponse(dependencies.requestId(), 410, null, {
      code: 'endpoint_removed',
      message: 'Используйте подписанную ссылку Telegram.',
    });
  };
}

export const POST = createRedeemInvitationHandler({ requestId: () => randomUUID() });
