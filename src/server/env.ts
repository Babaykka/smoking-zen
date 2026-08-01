import { z } from 'zod';

const telegramIdSchema = z
  .string()
  .regex(/^\d{1,16}$/)
  .refine((value) => BigInt(value) > 0n && BigInt(value) <= 4_503_599_627_370_495n);

const productionEnvironmentSchema = z.object({
  APP_MODE: z.literal('production'),
  APP_ORIGIN: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(3_600).default(300),
  SESSION_SECRET: z.string().min(32),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OWNER_TELEGRAM_ID: telegramIdSchema,
  WORKSPACE_NAME: z.string().trim().min(1).max(120).default('Smoking Zen'),
  NODE_ENV: z.string().optional(),
});

export type DemoServerEnvironment = {
  mode: 'demo';
  production: false;
};

export type ProductionServerEnvironment = {
  mode: 'production';
  production: true;
  appOrigin: string;
  telegramBotToken: string;
  telegramInitDataMaxAgeSeconds: number;
  sessionSecret: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  ownerTelegramId: string;
  workspaceName: string;
};

export type ServerEnvironment = DemoServerEnvironment | ProductionServerEnvironment;

export class ServerConfigurationError extends Error {
  constructor() {
    super('Production server configuration is incomplete.');
    this.name = 'ServerConfigurationError';
  }
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
    appOrigin: new URL(parsed.data.APP_ORIGIN).origin,
    telegramBotToken: parsed.data.TELEGRAM_BOT_TOKEN,
    telegramInitDataMaxAgeSeconds: parsed.data.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
    sessionSecret: parsed.data.SESSION_SECRET,
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseAnonKey: parsed.data.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    ownerTelegramId: parsed.data.OWNER_TELEGRAM_ID,
    workspaceName: parsed.data.WORKSPACE_NAME,
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
