export type TelegramFailureCode =
  | 'rate_limited'
  | 'telegram_unavailable'
  | 'network_error'
  | 'recipient_unavailable'
  | 'configuration_error'
  | 'invalid_response';

export class TelegramSendError extends Error {
  constructor(
    readonly code: TelegramFailureCode,
    readonly permanent: boolean,
    readonly retryAfterSeconds = 0,
  ) {
    super('Telegram delivery failed.');
    this.name = 'TelegramSendError';
  }
}

export type TelegramMessageInput = { chatId: string; text: string; taskUrl: string };
export type TelegramClient = { sendMessage(input: TelegramMessageInput): Promise<{ messageId: number }> };

type TelegramClientOptions = { token: string; fetcher?: typeof fetch };

const tokenPattern = /^\d{5,16}:[A-Za-z0-9_-]{30,100}$/u;
const chatPattern = /^\d{1,16}$/u;
const taskLinkPattern = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/[a-z][a-z0-9_]{2,29}\?startapp=task_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumResponseBytes = 16 * 1_024;

async function readCappedJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumResponseBytes) {
        await reader.cancel();
        return null;
      }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function classifyHttpFailure(status: number, payload: Record<string, unknown> | null): TelegramSendError {
  if (status === 401) return new TelegramSendError('configuration_error', true);
  if (status === 429) {
    const parameters = payload?.parameters;
    const rawDelay = parameters && typeof parameters === 'object' && !Array.isArray(parameters)
      ? (parameters as Record<string, unknown>).retry_after
      : null;
    const delay = typeof rawDelay === 'number' && Number.isInteger(rawDelay)
      ? Math.min(3_600, Math.max(1, rawDelay))
      : 60;
    return new TelegramSendError('rate_limited', false, delay);
  }
  if (status === 400 || status === 403) return new TelegramSendError('recipient_unavailable', true);
  if (status >= 500 && status <= 599) return new TelegramSendError('telegram_unavailable', false);
  return new TelegramSendError('invalid_response', false);
}

function inputIsValid(input: TelegramMessageInput): boolean {
  return chatPattern.test(input.chatId)
    && input.text.length > 0
    && input.text.length <= 4_096
    && taskLinkPattern.test(input.taskUrl);
}

export function createTelegramClient({ token, fetcher = fetch }: TelegramClientOptions): TelegramClient {
  return {
    async sendMessage(input) {
      if (!tokenPattern.test(token) || !inputIsValid(input)) {
        throw new TelegramSendError('configuration_error', true);
      }

      let response: Response;
      try {
        response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            chat_id: input.chatId,
            text: input.text,
            reply_markup: { inline_keyboard: [[{ text: 'Открыть задачу', url: input.taskUrl }]] },
          }),
          cache: 'no-store',
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        if (error instanceof TelegramSendError) throw error;
        throw new TelegramSendError('network_error', false);
      }

      const payload = await readCappedJson(response);
      if (!response.ok) throw classifyHttpFailure(response.status, payload);
      const result = payload?.result;
      const messageId = result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).message_id
        : null;
      if (payload?.ok !== true || typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new TelegramSendError('invalid_response', false);
      }
      return { messageId };
    },
  };
}
