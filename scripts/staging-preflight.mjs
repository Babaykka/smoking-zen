#!/usr/bin/env node

import {
  createHash, createPrivateKey, createPublicKey, timingSafeEqual,
} from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const environment = process.env;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IDENTITY_MANIFEST_PATH = resolve(SCRIPT_DIRECTORY, '../config/staging-identities.json');
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const TELEGRAM_BOT_ID = /^\d{5,16}$/u;
const TELEGRAM_BOT_USERNAME = /^(?=.{5,32}$)[A-Za-z0-9_]+bot$/iu;
const TELEGRAM_MINI_APP_SHORT_NAME = /^(?=.{3,30}$)[a-z][a-z0-9_]*$/u;
const OPERATION_SECRET = /^[A-Za-z0-9_-]{32,256}$/u;
const TELEGRAM_BOT_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,100}$/u;
const MODERN_PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{4,512}$/u;
const MODERN_SERVICE_KEY = /^sb_secret_[A-Za-z0-9_-]{4,512}$/u;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const IDENTITY_MANIFEST_KEYS = Object.freeze([
  'schemaVersion',
  'configured',
  'githubRepository',
  'appOrigin',
  'supabaseProjectRef',
  'supabaseDrillProjectRef',
  'telegramBotId',
  'telegramBotUsername',
  'telegramMiniAppShortName',
  'supabaseJwtKid',
  'supabaseJwtPublicKeySpkiSha256',
  'backupTargetEndpoint',
  'backupTargetBucket',
  'backupTargetPrefix',
]);

let identityManifest = null;

function has(name) {
  return environment[name] !== undefined;
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function hasExactKeys(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function exactHttpsOrigin(value) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 2_048
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const withoutOneTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== '/' || parsed.search || parsed.hash
    || parsed.origin !== withoutOneTrailingSlash
  ) return null;
  return parsed.origin;
}

function officialSupabaseProjectRef(value) {
  const origin = exactHttpsOrigin(value);
  if (!origin) return null;
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/u.exec(origin);
  return match?.[1] ?? null;
}

function canonicalHttpsEndpoint(value) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 2_048
    || /[\u0000-\u0020\u007f]/u.test(value) || value.includes('%')
    || !value.startsWith('https://')
  ) return null;

  const authorityAndPath = value.slice('https://'.length);
  const rawSlash = authorityAndPath.indexOf('/');
  if (rawSlash >= 0) {
    let rawPath = authorityAndPath.slice(rawSlash + 1);
    if (rawPath.endsWith('/')) rawPath = rawPath.slice(0, -1);
    if (rawPath && rawPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return null;
    }
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(hostname) || hostname.includes('..')) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment))) {
    return null;
  }
  const port = parsed.port && parsed.port !== '443' ? `:${parsed.port}` : '';
  const pathname = segments.length ? `/${segments.join('/')}` : '';
  return `https://${hostname}${port}${pathname}`;
}

function validBucket(value) {
  return typeof value === 'string'
    && value.length >= 3 && value.length <= 63
    && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(value)
    && !value.includes('..')
    && !/^\d+\.\d+\.\d+\.\d+$/u.test(value);
}

function validStagingPrefix(value) {
  if (typeof value !== 'string' || !value.includes('/') || value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  return segments[0] === 'staging' && segments.every((segment) => (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment) && segment !== '.' && segment !== '..'
  ));
}

function legacyJwtRole(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 8_192) return null;
  const segments = value.split('.');
  if (segments.length !== 3 || segments.some((segment) => (
    segment.length > 4_096 || !BASE64URL_SEGMENT.test(segment)
  ))) return null;
  try {
    const headerBytes = Buffer.from(segments[0], 'base64url');
    const payloadBytes = Buffer.from(segments[1], 'base64url');
    if (headerBytes.byteLength < 2 || headerBytes.byteLength > 1_024
      || payloadBytes.byteLength < 2 || payloadBytes.byteLength > 2_048
      || headerBytes.toString('base64url') !== segments[0]
      || payloadBytes.toString('base64url') !== segments[1]
      || segments[2].length !== 43) return null;
    const header = JSON.parse(headerBytes.toString('utf8'));
    const payload = JSON.parse(payloadBytes.toString('utf8'));
    const now = Math.floor(Date.now() / 1_000);
    if (!header || typeof header !== 'object' || Array.isArray(header)
      || header.alg !== 'HS256' || header.typ !== 'JWT'
      || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.iss !== 'supabase'
      || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
      || payload.iat > now + 300 || payload.exp <= now || payload.exp <= payload.iat) return null;
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

function strongOperationSecret(value) {
  return typeof value === 'string'
    && OPERATION_SECRET.test(value)
    && new Set(value).size >= 12;
}

function validPublishableKey(value) {
  return typeof value === 'string'
    && (MODERN_PUBLISHABLE_KEY.test(value) || legacyJwtRole(value) === 'anon');
}

function validServiceKey(value) {
  return typeof value === 'string'
    && (MODERN_SERVICE_KEY.test(value) || legacyJwtRole(value) === 'service_role');
}

function validOriginList(value) {
  if (value === undefined || !value.trim()) return true;
  return value.split(',').every((entry) => exactHttpsOrigin(entry.trim()) !== null);
}

function validTelegramId(value) {
  if (typeof value !== 'string' || !/^\d{1,16}$/u.test(value)) return false;
  try {
    const identifier = BigInt(value);
    return identifier > 0n && identifier <= 4_503_599_627_370_495n;
  } catch {
    return false;
  }
}

function p256PrivateKeyFingerprint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || value.includes('\u0000')) return null;
  const pem = value.replace(/\\n/gu, '\n');
  const trimmed = pem.endsWith('\n') ? pem.slice(0, -1) : pem;
  if (!trimmed.startsWith('-----BEGIN PRIVATE KEY-----\n') || !trimmed.endsWith('\n-----END PRIVATE KEY-----')) {
    return null;
  }
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' });
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ec'
      || (curve !== 'prime256v1' && curve !== 'P-256')) return null;
    const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
    return `sha256:${createHash('sha256').update(spki).digest('hex')}`;
  } catch {
    return null;
  }
}

function loadIdentityManifest() {
  try {
    const metadata = lstatSync(IDENTITY_MANIFEST_PATH);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) return null;
    const source = readFileSync(IDENTITY_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(source);
    if (source !== `${JSON.stringify(parsed, null, 2)}\n`) return null;
    if (!hasExactKeys(parsed, IDENTITY_MANIFEST_KEYS)
      || parsed.schemaVersion !== 1 || parsed.configured !== true
      || typeof parsed.githubRepository !== 'string'
      || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(parsed.githubRepository)
      || exactHttpsOrigin(parsed.appOrigin) !== parsed.appOrigin
      || !PROJECT_REF.test(parsed.supabaseProjectRef)
      || !PROJECT_REF.test(parsed.supabaseDrillProjectRef)
      || constantTimeEqual(parsed.supabaseProjectRef, parsed.supabaseDrillProjectRef)
      || !TELEGRAM_BOT_ID.test(parsed.telegramBotId)
      || !TELEGRAM_BOT_USERNAME.test(parsed.telegramBotUsername)
      || !TELEGRAM_MINI_APP_SHORT_NAME.test(parsed.telegramMiniAppShortName)
      || typeof parsed.supabaseJwtKid !== 'string'
      || parsed.supabaseJwtKid.trim() !== parsed.supabaseJwtKid
      || parsed.supabaseJwtKid.length < 1 || parsed.supabaseJwtKid.length > 200
      || !SHA256_FINGERPRINT.test(parsed.supabaseJwtPublicKeySpkiSha256)
      || canonicalHttpsEndpoint(parsed.backupTargetEndpoint) !== parsed.backupTargetEndpoint
      || !validBucket(parsed.backupTargetBucket)
      || !validStagingPrefix(parsed.backupTargetPrefix)) return null;
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

function identityManifestIsBound() {
  if (identityManifest === null) return false;
  const actualRepository = environment.STAGING_ACTUAL_GITHUB_REPOSITORY;
  return typeof actualRepository === 'string'
    && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(actualRepository)
    && constantTimeEqual(actualRepository, identityManifest.githubRepository);
}

function appOriginIsPinned() {
  if (identityManifest === null) return false;
  const actual = exactHttpsOrigin(environment.APP_ORIGIN);
  const expected = exactHttpsOrigin(environment.STAGING_EXPECTED_APP_ORIGIN);
  return actual !== null && expected !== null
    && constantTimeEqual(actual, identityManifest.appOrigin)
    && constantTimeEqual(expected, identityManifest.appOrigin);
}

function supabaseProjectIsPinned() {
  if (identityManifest === null) return false;
  const expected = environment.STAGING_EXPECTED_SUPABASE_PROJECT_REF;
  const actual = officialSupabaseProjectRef(environment.SUPABASE_URL);
  return typeof expected === 'string' && PROJECT_REF.test(expected)
    && actual !== null
    && constantTimeEqual(expected, identityManifest.supabaseProjectRef)
    && constantTimeEqual(actual, identityManifest.supabaseProjectRef);
}

function backupSourceRefsArePinned() {
  if (identityManifest === null) return false;
  const expected = identityManifest.supabaseProjectRef;
  return typeof environment.BACKUP_SOURCE_PROJECT_REF === 'string'
    && PROJECT_REF.test(environment.BACKUP_SOURCE_PROJECT_REF)
    && constantTimeEqual(environment.BACKUP_SOURCE_PROJECT_REF, expected)
    && (!has('RESTORE_SOURCE_PROJECT_REF') || (
      PROJECT_REF.test(environment.RESTORE_SOURCE_PROJECT_REF)
      && constantTimeEqual(environment.RESTORE_SOURCE_PROJECT_REF, expected)
    ));
}

function backupSourceStorageIsPinned() {
  if (identityManifest === null) return false;
  const expected = identityManifest.supabaseProjectRef;
  const endpoint = canonicalHttpsEndpoint(environment.BACKUP_SOURCE_ENDPOINT);
  return endpoint !== null
    && constantTimeEqual(endpoint, `https://${expected}.storage.supabase.co/storage/v1/s3`);
}

function backupSourcePostgresIsPinned() {
  const names = ['BACKUP_PGHOST', 'BACKUP_PGPORT', 'BACKUP_PGDATABASE', 'BACKUP_PGUSER', 'BACKUP_PGSSLMODE'];
  if (!names.every(has)) return false;

  if (identityManifest === null) return false;
  const expected = identityManifest.supabaseProjectRef;
  if (
    environment.BACKUP_PGPORT !== '5432' || environment.BACKUP_PGDATABASE !== 'postgres'
    || environment.BACKUP_PGSSLMODE !== 'verify-full'
  ) return false;

  const direct = environment.BACKUP_PGHOST === `db.${expected}.supabase.co`
    && environment.BACKUP_PGUSER === 'smoking_zen_backup_reader';
  const sessionPooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/u.test(environment.BACKUP_PGHOST)
    && environment.BACKUP_PGUSER === `smoking_zen_backup_reader.${expected}`;
  return direct || sessionPooler;
}

function telegramIdentityIsPinned() {
  if (identityManifest === null) return false;
  const actualUsername = environment.TELEGRAM_BOT_USERNAME;
  const expectedUsername = environment.STAGING_EXPECTED_TELEGRAM_BOT_USERNAME;
  const actualShortName = environment.TELEGRAM_MINI_APP_SHORT_NAME;
  const expectedShortName = environment.STAGING_EXPECTED_TELEGRAM_MINI_APP_SHORT_NAME;
  const botTokenMatch = /^(\d{5,16}):/u.exec(environment.TELEGRAM_BOT_TOKEN ?? '');
  return typeof actualUsername === 'string' && typeof expectedUsername === 'string'
    && typeof actualShortName === 'string' && typeof expectedShortName === 'string'
    && TELEGRAM_BOT_USERNAME.test(actualUsername) && TELEGRAM_BOT_USERNAME.test(expectedUsername)
    && TELEGRAM_MINI_APP_SHORT_NAME.test(actualShortName)
    && TELEGRAM_MINI_APP_SHORT_NAME.test(expectedShortName)
    && constantTimeEqual(actualUsername, identityManifest.telegramBotUsername)
    && constantTimeEqual(expectedUsername, identityManifest.telegramBotUsername)
    && constantTimeEqual(actualShortName, identityManifest.telegramMiniAppShortName)
    && constantTimeEqual(expectedShortName, identityManifest.telegramMiniAppShortName)
    && botTokenMatch !== null
    && constantTimeEqual(botTokenMatch[1], identityManifest.telegramBotId);
}

function backupTargetEndpointIsIndependent() {
  if (identityManifest === null) return false;
  const target = canonicalHttpsEndpoint(environment.BACKUP_TARGET_ENDPOINT);
  if (!target) return false;
  const hostname = new URL(target).hostname;
  if (hostname === 'supabase.co' || hostname.endsWith('.supabase.co')) return false;

  const expected = identityManifest.supabaseProjectRef;
  const officialSource = `https://${expected}.storage.supabase.co/storage/v1/s3`;
  if (constantTimeEqual(target, officialSource)) return false;
  if (!constantTimeEqual(target, identityManifest.backupTargetEndpoint)) return false;

  if (has('BACKUP_SOURCE_ENDPOINT')) {
    const configuredSource = canonicalHttpsEndpoint(environment.BACKUP_SOURCE_ENDPOINT);
    if (!configuredSource || constantTimeEqual(target, configuredSource)) return false;
  }
  return true;
}

function backupTargetBucketIsPinned() {
  return identityManifest !== null
    && validBucket(environment.BACKUP_TARGET_BUCKET)
    && constantTimeEqual(environment.BACKUP_TARGET_BUCKET, identityManifest.backupTargetBucket);
}

function backupTargetPrefixIsPinned() {
  return identityManifest !== null
    && validStagingPrefix(environment.BACKUP_TARGET_PREFIX)
    && constantTimeEqual(environment.BACKUP_TARGET_PREFIX, identityManifest.backupTargetPrefix);
}

function es256KidIsPinned() {
  if (identityManifest === null) return false;
  const actual = environment.SUPABASE_JWT_KID;
  const expected = environment.STAGING_EXPECTED_SUPABASE_JWT_KID;
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const normalizedActual = actual.trim();
  const normalizedExpected = expected.trim();
  return normalizedActual.length >= 1 && normalizedActual.length <= 200
    && normalizedExpected.length >= 1 && normalizedExpected.length <= 200
    && constantTimeEqual(normalizedActual, identityManifest.supabaseJwtKid)
    && constantTimeEqual(normalizedExpected, identityManifest.supabaseJwtKid);
}

function vaultOriginMatches() {
  if (identityManifest === null) return false;
  const vaultOrigin = exactHttpsOrigin(environment.STAGING_VAULT_APP_ORIGIN);
  const appOrigin = exactHttpsOrigin(environment.APP_ORIGIN);
  return vaultOrigin !== null && appOrigin !== null
    && constantTimeEqual(vaultOrigin, identityManifest.appOrigin)
    && constantTimeEqual(appOrigin, identityManifest.appOrigin);
}

function vaultSecretMatches() {
  const vaultSecret = environment.STAGING_VAULT_INTERNAL_JOB_SECRET;
  const applicationSecret = environment.INTERNAL_JOB_SECRET;
  return typeof vaultSecret === 'string' && typeof applicationSecret === 'string'
    && strongOperationSecret(vaultSecret) && strongOperationSecret(applicationSecret)
    && constantTimeEqual(vaultSecret, applicationSecret);
}

function es256PrivateKeyIsPinned() {
  if (identityManifest === null) return false;
  const fingerprint = p256PrivateKeyFingerprint(environment.SUPABASE_JWT_ES256_PRIVATE_KEY);
  return fingerprint !== null
    && constantTimeEqual(fingerprint, identityManifest.supabaseJwtPublicKeySpkiSha256);
}

function productionEnvironmentIsValid() {
  const initializationAge = environment.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS === undefined
    ? 300 : Number(environment.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS);
  const workspaceName = environment.WORKSPACE_NAME === undefined ? 'Smoking Zen' : environment.WORKSPACE_NAME.trim();
  const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;

  return TELEGRAM_BOT_TOKEN.test(environment.TELEGRAM_BOT_TOKEN ?? '')
    && strongOperationSecret(environment.TELEGRAM_WEBHOOK_SECRET)
    && strongOperationSecret(environment.INTERNAL_JOB_SECRET)
    && strongOperationSecret(environment.SESSION_SECRET)
    && Number.isInteger(initializationAge) && initializationAge > 0 && initializationAge <= 3_600
    && validPublishableKey(publishableKey) && validServiceKey(serviceKey)
    && !constantTimeEqual(publishableKey, serviceKey)
    && validTelegramId(environment.OWNER_TELEGRAM_ID)
    && workspaceName.length >= 1 && workspaceName.length <= 120
    && validOriginList(environment.SUPABASE_SELF_HOSTED_ORIGINS)
    && validOriginList(environment.BITWARDEN_SELF_HOSTED_ORIGINS);
}

identityManifest = loadIdentityManifest();

const checks = [
  ['001_APP_MODE', () => environment.APP_MODE === 'production'],
  ['002_DEPLOYMENT_ENVIRONMENT', () => environment.DEPLOYMENT_ENVIRONMENT === 'staging'],
  ['003_IDENTITY_MANIFEST', identityManifestIsBound],
  ['004_APP_ORIGIN', appOriginIsPinned],
  ['005_SUPABASE_PROJECT', supabaseProjectIsPinned],
  ['006_BACKUP_SOURCE_REF', backupSourceRefsArePinned],
  ['007_BACKUP_SOURCE_STORAGE', backupSourceStorageIsPinned],
  ['008_BACKUP_SOURCE_POSTGRES', backupSourcePostgresIsPinned],
  ['009_TELEGRAM_IDENTITY', telegramIdentityIsPinned],
  ['010_BACKUP_TARGET_ENDPOINT', backupTargetEndpointIsIndependent],
  ['011_BACKUP_TARGET_BUCKET', backupTargetBucketIsPinned],
  ['012_BACKUP_TARGET_PREFIX', backupTargetPrefixIsPinned],
  ['013_ES256_PRIVATE_KEY', es256PrivateKeyIsPinned],
  ['014_ES256_KID', es256KidIsPinned],
  ['015_VAULT_ORIGIN', vaultOriginMatches],
  ['016_VAULT_SECRET', vaultSecretMatches],
  ['017_PRODUCTION_ENVIRONMENT', productionEnvironmentIsValid],
  ['018_BACKUP_SOURCE_BUCKET', () => environment.BACKUP_SOURCE_BUCKET === 'workspace-files'],
];

if (process.argv.length !== 2) {
  process.stdout.write('STAGING_PREFLIGHT_ERROR_000_ARGUMENTS\n');
  process.exitCode = 2;
} else {
  try {
    const results = checks.map(([identifier, validate]) => ({ identifier, passed: validate() === true }));
    const failures = results.filter(({ passed }) => !passed);
    const codes = failures.length > 0
      ? failures.map(({ identifier }) => `STAGING_PREFLIGHT_ERROR_${identifier}`)
      : [
          ...results.map(({ identifier }) => `STAGING_PREFLIGHT_PASS_${identifier}`),
          'STAGING_PREFLIGHT_PASS_019_COMPLETE',
        ];
    process.stdout.write(`${codes.join('\n')}\n`);
    if (failures.length > 0) process.exitCode = 1;
  } catch {
    process.stdout.write('STAGING_PREFLIGHT_ERROR_999_INTERNAL\n');
    process.exitCode = 1;
  }
}
