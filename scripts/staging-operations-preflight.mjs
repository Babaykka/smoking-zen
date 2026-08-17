#!/usr/bin/env node

import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const environment = process.env;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IDENTITY_MANIFEST_PATH = resolve(SCRIPT_DIRECTORY, '../config/staging-identities.json');
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const SNAPSHOT_ID = /^\d{8}T\d{6}Z$/u;
const OPERATIONS = new Set(['backup-dry-run', 'backup-snapshot', 'freshness', 'restore-drill']);
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

function pass(code, label) {
  process.stdout.write(`STAGING_OPERATIONS_PREFLIGHT_PASS_${code}_${label}\n`);
}

function fail(code, label) {
  process.stderr.write(`STAGING_OPERATIONS_PREFLIGHT_ERROR_${code}_${label}\n`);
  process.exitCode = 1;
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
    if (rawPath && rawPath.split('/').some((segment) => (
      segment === '' || segment === '.' || segment === '..'
    ))) return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash
  ) return null;

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(hostname) || hostname.includes('..')) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.some((segment) => !/^[A-Za-z0-9._-]+$/u.test(segment))) return null;
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
  if (
    typeof value !== 'string' || !value.includes('/')
    || value.startsWith('/') || value.endsWith('/')
  ) return false;
  const segments = value.split('/');
  return segments[0] === 'staging' && segments.every((segment) => (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment) && segment !== '.' && segment !== '..'
  ));
}

function independentBackupEndpoint(value) {
  const endpoint = canonicalHttpsEndpoint(value);
  if (endpoint === null) return null;
  const hostname = new URL(endpoint).hostname;
  if (hostname === 'supabase.co' || hostname.endsWith('.supabase.co')) return null;
  return endpoint;
}

function loadIdentityManifest() {
  try {
    const metadata = lstatSync(IDENTITY_MANIFEST_PATH);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) return null;
    const source = readFileSync(IDENTITY_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(source);
    if (source !== `${JSON.stringify(parsed, null, 2)}\n`) return null;
    if (
      !hasExactKeys(parsed, IDENTITY_MANIFEST_KEYS)
      || parsed.schemaVersion !== 1 || parsed.configured !== true
      || typeof parsed.githubRepository !== 'string'
      || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(parsed.githubRepository)
      || !PROJECT_REF.test(parsed.supabaseProjectRef)
      || !PROJECT_REF.test(parsed.supabaseDrillProjectRef)
      || constantTimeEqual(parsed.supabaseProjectRef, parsed.supabaseDrillProjectRef)
      || independentBackupEndpoint(parsed.backupTargetEndpoint) !== parsed.backupTargetEndpoint
      || !validBucket(parsed.backupTargetBucket)
      || !validStagingPrefix(parsed.backupTargetPrefix)
    ) return null;
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

function sourceIsPinned(identityManifest) {
  const expectedEndpoint = `https://${identityManifest.supabaseProjectRef}.storage.supabase.co/storage/v1/s3`;
  return PROJECT_REF.test(environment.BACKUP_SOURCE_PROJECT_REF ?? '')
    && constantTimeEqual(environment.BACKUP_SOURCE_PROJECT_REF, identityManifest.supabaseProjectRef)
    && constantTimeEqual(canonicalHttpsEndpoint(environment.BACKUP_SOURCE_ENDPOINT), expectedEndpoint);
}

function backupTargetIsPinned(identityManifest) {
  const endpoint = independentBackupEndpoint(environment.BACKUP_TARGET_ENDPOINT);
  return endpoint !== null
    && constantTimeEqual(endpoint, identityManifest.backupTargetEndpoint)
    && validBucket(environment.BACKUP_TARGET_BUCKET)
    && constantTimeEqual(environment.BACKUP_TARGET_BUCKET, identityManifest.backupTargetBucket)
    && validStagingPrefix(environment.BACKUP_TARGET_PREFIX)
    && constantTimeEqual(environment.BACKUP_TARGET_PREFIX, identityManifest.backupTargetPrefix);
}

function restoreContourIsPinned(identityManifest) {
  const sourceEndpoint = `https://${identityManifest.supabaseProjectRef}.storage.supabase.co/storage/v1/s3`;
  const drillEndpoint = `https://${identityManifest.supabaseDrillProjectRef}.storage.supabase.co/storage/v1/s3`;
  const snapshot = environment.STAGING_OPERATIONS_RESTORE_SNAPSHOT_ID;
  const expectedAcknowledgement = `RESTORE_ISOLATED_TARGET:${identityManifest.supabaseDrillProjectRef}:${snapshot}`;
  return SNAPSHOT_ID.test(snapshot ?? '')
    && constantTimeEqual(
      environment.STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT,
      expectedAcknowledgement,
    )
    && constantTimeEqual(environment.RESTORE_SOURCE_PROJECT_REF, identityManifest.supabaseProjectRef)
    && constantTimeEqual(environment.RESTORE_TARGET_PROJECT_REF, identityManifest.supabaseDrillProjectRef)
    && constantTimeEqual(canonicalHttpsEndpoint(environment.BACKUP_SOURCE_ENDPOINT), sourceEndpoint)
    && constantTimeEqual(
      independentBackupEndpoint(environment.RESTORE_ARCHIVE_ENDPOINT),
      identityManifest.backupTargetEndpoint,
    )
    && constantTimeEqual(environment.RESTORE_ARCHIVE_BUCKET, identityManifest.backupTargetBucket)
    && constantTimeEqual(environment.RESTORE_ARCHIVE_PREFIX, identityManifest.backupTargetPrefix)
    && constantTimeEqual(canonicalHttpsEndpoint(environment.RESTORE_TARGET_ENDPOINT), drillEndpoint);
}

function nonRestoreInputsAreEmpty() {
  return [
    'STAGING_OPERATIONS_RESTORE_SNAPSHOT_ID',
    'STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT',
    'RESTORE_SOURCE_PROJECT_REF',
    'RESTORE_TARGET_PROJECT_REF',
    'RESTORE_ARCHIVE_ENDPOINT',
    'RESTORE_ARCHIVE_BUCKET',
    'RESTORE_ARCHIVE_PREFIX',
    'RESTORE_TARGET_ENDPOINT',
  ].every((name) => environment[name] === undefined || environment[name] === '');
}

if (process.argv.length !== 2 || !OPERATIONS.has(environment.STAGING_OPERATIONS_OPERATION)) {
  fail('001', 'OPERATION');
} else {
  pass('001', 'OPERATION');
}

const identityManifest = loadIdentityManifest();
if (identityManifest === null) {
  fail('002', 'IDENTITY_MANIFEST');
} else {
  pass('002', 'IDENTITY_MANIFEST');
}

if (
  identityManifest === null
  || !constantTimeEqual(
    environment.STAGING_ACTUAL_GITHUB_REPOSITORY,
    identityManifest.githubRepository,
  )
) {
  fail('003', 'GITHUB_REPOSITORY');
} else {
  pass('003', 'GITHUB_REPOSITORY');
}

if (identityManifest === null || !sourceIsPinned(identityManifest)) {
  fail('004', 'BACKUP_SOURCE');
} else {
  pass('004', 'BACKUP_SOURCE');
}

if (identityManifest === null || !backupTargetIsPinned(identityManifest)) {
  fail('005', 'BACKUP_TARGET');
} else {
  pass('005', 'BACKUP_TARGET');
}

if (environment.STAGING_OPERATIONS_OPERATION === 'restore-drill') {
  if (identityManifest === null || !restoreContourIsPinned(identityManifest)) {
    fail('006', 'RESTORE_CONTOUR');
  } else {
    pass('006', 'RESTORE_CONTOUR');
  }
} else if (!nonRestoreInputsAreEmpty()) {
  fail('007', 'RESTORE_INPUTS');
} else {
  pass('006', 'NON_RESTORE_INPUTS');
}

if (process.exitCode !== 1) pass('007', 'COMPLETE');
