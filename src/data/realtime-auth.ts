type TokenPayload = { token: string; workspaceId: string; expiresAt: string };
type ApiEnvelope<T> = { data: T | null; error: { message: string } | null };

type RealtimeTokenManagerOptions = {
  fetcher?: typeof fetch;
  now?: () => Date;
  setAuth?: (token: string) => void | Promise<void>;
};

export type RealtimeTokenManager = ReturnType<typeof createRealtimeTokenManager>;

const WORKSPACE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_SKEW_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;
const MAX_REFRESH_RETRIES = 5;

function isValidTokenPayload(value: unknown, now: Date): value is TokenPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TokenPayload>;
  const expiresAt = typeof candidate.expiresAt === 'string' ? Date.parse(candidate.expiresAt) : Number.NaN;
  return typeof candidate.token === 'string' && candidate.token.length > 0
    && typeof candidate.workspaceId === 'string' && WORKSPACE_UUID.test(candidate.workspaceId)
    && Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

export function createRealtimeTokenManager(options: RealtimeTokenManagerOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  let current: TokenPayload | null = null;
  let loading: Promise<TokenPayload> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let refreshRetries = 0;

  const cancelRefresh = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
  };

  const scheduleRetry = () => {
    if (!current || refreshRetries >= MAX_REFRESH_RETRIES) return;
    cancelRefresh();
    const delay = Math.min(30_000, MIN_REFRESH_DELAY_MS * (2 ** refreshRetries));
    refreshRetries += 1;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh().catch(() => { /* refresh schedules the next bounded retry */ });
    }, delay);
  };

  const refresh = async () => {
    try {
      await load();
    } catch (error) {
      scheduleRetry();
      throw error;
    }
  };

  const scheduleRefresh = (payload: TokenPayload) => {
    cancelRefresh();
    refreshRetries = 0;
    const delay = Math.max(MIN_REFRESH_DELAY_MS, Date.parse(payload.expiresAt) - now().getTime() - REFRESH_SKEW_MS);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh().catch(() => { /* The authenticated UI keeps its last safe state during bounded retries. */ });
    }, delay);
  };

  const load = async (): Promise<TokenPayload> => {
    if (loading) return loading;
    const loadGeneration = generation;
    const operation = (async () => {
      const response = await fetcher('/api/realtime/token', {
        method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' },
      });
      const envelope = await response.json() as ApiEnvelope<TokenPayload>;
      if (!response.ok || !envelope.data) {
        throw new Error(envelope.error?.message ?? 'Не удалось подключить совместную работу.');
      }
      if (!isValidTokenPayload(envelope.data, now())) throw new Error('Сервер вернул некорректные данные совместной работы.');
      if (loadGeneration !== generation) throw new Error('Подключение совместной работы остановлено.');
      await options.setAuth?.(envelope.data.token);
      if (loadGeneration !== generation) throw new Error('Подключение совместной работы остановлено.');
      current = envelope.data;
      scheduleRefresh(envelope.data);
      return envelope.data;
    })();
    loading = operation;
    try {
      return await operation;
    } finally {
      if (loading === operation) loading = null;
    }
  };

  return {
    async getAccessToken(): Promise<string> {
      const refreshAt = current ? Date.parse(current.expiresAt) - 60_000 : 0;
      if (!current || now().getTime() >= refreshAt) await load();
      return current!.token;
    },
    async getWorkspaceId(): Promise<string> {
      if (!current) await load();
      return current!.workspaceId;
    },
    peek: () => current?.token ?? null,
    clear() {
      generation += 1;
      refreshRetries = 0;
      cancelRefresh();
      current = null;
      loading = null;
    },
  };
}
