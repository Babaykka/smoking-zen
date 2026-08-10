import 'server-only';

import { z } from 'zod';

const telegramIdSchema = z
  .string()
  .regex(/^\d{1,16}$/)
  .refine((value) => BigInt(value) > 0n && BigInt(value) <= 4_503_599_627_370_495n);

const exactHttpsOriginSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash
      && url.origin === value.replace(/\/$/u, '');
  } catch {
    return false;
  }
});

const telegramBotTokenSchema = z.string().regex(/^\d{5,16}:[A-Za-z0-9_-]{30,100}$/u);
const telegramBotUsernameSchema = z.string().regex(/^(?=.{5,32}$)[A-Za-z0-9_]+bot$/iu);
const telegramMiniAppShortNameSchema = z.string().regex(/^(?=.{3,30}$)[a-z][a-z0-9_]*$/u);
const operationSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u);
const MODERN_PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{4,512}$/u;
const MODERN_SERVICE_KEY = /^sb_secret_[A-Za-z0-9_-]{4,512}$/u;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/u;

function legacyJwtRole(value: string): string | null {
  if (value.length < 16 || value.length > 8_192) return null;
  const segments = value.split('.');
  if (segments.length !== 3 || segments.some((segment) => !BASE64URL_SEGMENT.test(segment) || segment.length > 4_096)) return null;
  try {
    const decoded = Buffer.from(segments[1]!, 'base64url');
    if (decoded.byteLength < 2 || decoded.byteLength > 2_048) return null;
    const payload = JSON.parse(decoded.toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const role = (payload as Record<string, unknown>).role;
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}

const supabasePublishableKeySchema = z.string().refine(
  (value) => MODERN_PUBLISHABLE_KEY.test(value) || legacyJwtRole(value) === 'anon',
);
const supabaseServiceRoleKeySchema = z.string().refine(
  (value) => MODERN_SERVICE_KEY.test(value) || legacyJwtRole(value) === 'service_role',
);

const selfHostedBitwardenOriginsSchema = z.string().optional().transform((raw, context) => {
  if (!raw?.trim()) return [] as string[];
  const origins: string[] = [];
  for (const entry of raw.split(',')) {
    const value = entry.trim();
    try {
      const url = new URL(value);
      if (
        !value || url.protocol !== 'https:' || url.username || url.password || url.port
        || url.pathname !== '/' || url.search || url.hash || url.origin !== value.replace(/\/$/u, '')
      ) throw new Error('invalid origin');
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid Bitwarden self-hosted origin.' });
      return z.NEVER;
    }
  }
  return origins;
});

const selfHostedSupabaseOriginsSchema = z.string().optional().transform((raw, context) => {
  if (!raw?.trim()) return [] as string[];
  const origins: string[] = [];
  for (const entry of raw.split(',')) {
    const value = entry.trim();
    const parsed = exactHttpsOriginSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: 'Invalid Supabase self-hosted origin.' });
      return z.NEVER;
    }
    const origin = new URL(parsed.data).origin;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
});

const productionEnvironmentSchema = z.object({
  APP_MODE: z.literal('production'),
  DEPLOYMENT_ENVIRONMENT: z.enum(['staging', 'production']),
  APP_ORIGIN: exactHttpsOriginSchema,
  TELEGRAM_BOT_TOKEN: telegramBotTokenSchema,
  TELEGRAM_BOT_USERNAME: telegramBotUsernameSchema,
  TELEGRAM_MINI_APP_SHORT_NAME: telegramMiniAppShortNameSchema,
  TELEGRAM_WEBHOOK_SECRET: operationSecretSchema,
  INTERNAL_JOB_SECRET: operationSecretSchema,
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(3_600).default(300),
  SESSION_SECRET: z.string().min(32),
  SUPABASE_URL: exactHttpsOriginSchema,
  SUPABASE_SELF_HOSTED_ORIGINS: selfHostedSupabaseOriginsSchema,
  SUPABASE_PUBLISHABLE_KEY: supabasePublishableKeySchema,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKeySchema,
  SUPABASE_JWT_ES256_PRIVATE_KEY: z.string().min(1),
  SUPABASE_JWT_KID: z.string().trim().min(1).max(200),
  OWNER_TELEGRAM_ID: telegramIdSchema,
  WORKSPACE_NAME: z.string().trim().min(1).max(120).default('Smoking Zen'),
  BITWARDEN_SELF_HOSTED_ORIGINS: selfHostedBitwardenOriginsSchema,
  NODE_ENV: z.string().optional(),
}).superRefine((value, context) => {
  const origin = new URL(value.SUPABASE_URL).origin;
  const hostname = new URL(origin).hostname;
  const officialProject = /^[a-z0-9]{20}\.supabase\.co$/u.test(hostname);
  if (!officialProject && !value.SUPABASE_SELF_HOSTED_ORIGINS.includes(origin)) {
    context.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'Untrusted Supabase origin.' });
  }
  if (value.SUPABASE_PUBLISHABLE_KEY === value.SUPABASE_SERVICE_ROLE_KEY) {
    context.addIssue({ code: 'custom', path: ['SUPABASE_PUBLISHABLE_KEY'], message: 'Supabase browser and service keys must differ.' });
  }
});

export type DemoServerEnvironment = {
  mode: 'demo';
  production: false;
};

export type ProductionServerEnvironment = {
  mode: 'production';
  production: true;
  deploymentEnvironment: 'staging' | 'production';
  appOrigin: string;
  telegramBotToken: string;
  telegramBotUsername: string;
  telegramMiniAppShortName: string;
  telegramWebhookSecret: string;
  internalJobSecret: string;
  telegramInitDataMaxAgeSeconds: number;
  sessionSecret: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseServiceRoleKey: string;
  supabaseJwtEs256PrivateKey: string;
  supabaseJwtKid: string;
  ownerTelegramId: string;
  workspaceName: string;
  bitwardenSelfHostedOrigins: string[];
};

export type ServerEnvironment = DemoServerEnvironment | ProductionServerEnvironment;

export type BrowserProductionEnvironment = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  telegramLaunchUrl?: string;
};

export class ServerConfigurationError extends Error {
  constructor() {
    super('Production server configuration is incomplete.');
    this.name = 'ServerConfigurationError';
  }
}

/**
 * Return only values that are safe to serialize into the browser document.
 * This intentionally validates independently of the credentialed server parser:
 * the first page render must never expose a misplaced service-role credential.
 */
export function parseBrowserProductionEnvironment(
  source: Record<string, string | undefined>,
): BrowserProductionEnvironment | undefined {
  if (source.APP_MODE !== 'production') return undefined;

  const url = exactHttpsOriginSchema.safeParse(source.SUPABASE_URL);
  const publishableKey = supabasePublishableKeySchema.safeParse(source.SUPABASE_PUBLISHABLE_KEY);
  const selfHostedOrigins = selfHostedSupabaseOriginsSchema.safeParse(source.SUPABASE_SELF_HOSTED_ORIGINS);
  if (!url.success || !publishableKey.success || !selfHostedOrigins.success) return undefined;

  const supabaseOrigin = new URL(url.data).origin;
  const officialProject = /^[a-z0-9]{20}\.supabase\.co$/u.test(new URL(supabaseOrigin).hostname);
  if (!officialProject && !selfHostedOrigins.data.includes(supabaseOrigin)) return undefined;
  if (source.SUPABASE_SERVICE_ROLE_KEY && publishableKey.data === source.SUPABASE_SERVICE_ROLE_KEY) return undefined;

  const botUsername = telegramBotUsernameSchema.safeParse(source.TELEGRAM_BOT_USERNAME);
  const shortName = telegramMiniAppShortNameSchema.safeParse(source.TELEGRAM_MINI_APP_SHORT_NAME);
  const telegramLaunchUrl = botUsername.success && shortName.success
    ? `https://t.me/${botUsername.data}/${shortName.data}`
    : undefined;

  return {
    supabaseUrl: url.data,
    supabasePublishableKey: publishableKey.data,
    ...(telegramLaunchUrl ? { telegramLaunchUrl } : {}),
  };
}

export function parseServerEnvironment(source: Record<string, string | undefined>): ServerEnvironment {
  if (source.APP_MODE === 'demo') {
    return { mode: 'demo', production: false };
  }

  const parsed = productionEnvironmentSchema.safeParse(source);
  if (!parsed.success) throw new ServerConfigurationError();

  return {
    mode: 'production',
    production: true,
    deploymentEnvironment: parsed.data.DEPLOYMENT_ENVIRONMENT,
    appOrigin: new URL(parsed.data.APP_ORIGIN).origin,
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    telegramBotUsername: parsed.data.TELEGRAM_BOT_USERNAME,
    telegramMiniAppShortName: parsed.data.TELEGRAM_MINI_APP_SHORT_NAME,
    telegramWebhookSecret: parsed.data.TELEGRAM_WEBHOOK_SECRET,
    internalJobSecret: parsed.data.INTERNAL_JOB_SECRET,
    telegramInitDataMaxAgeSeconds: parsed.data.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    sessionSecret: parsed.data.SESSION_SECRET,
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabasePublishableKey: parsed.data.SUPABASE_PUBLISHABLE_KEY,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    supabaseJwtEs256PrivateKey: parsed.data.SUPABASE_JWT_ES256_PRIVATE_KEY,
    supabaseJwtKid: parsed.data.SUPABASE_JWT_KID,
    ownerTelegramId: parsed.data.OWNER_TELEGRAM_ID,
    workspaceName: parsed.data.WORKSPACE_NAME,
    bitwardenSelfHostedOrigins: parsed.data.BITWARDEN_SELF_HOSTED_ORIGINS,
  };
}

export function getServerEnvironment(): ServerEnvironment {
  return parseServerEnvironment(process.env);
}

export function requireProductionEnvironment(): ProductionServerEnvironment {
  const environment = getServerEnvironment();
  if (environment.mode !== 'production') throw new ServerConfigurationError();
  return environment;
}
