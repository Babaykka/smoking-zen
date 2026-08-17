#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_VALIDITY_MS = 26 * 60 * 60 * 1000;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(SCRIPT_DIRECTORY, '..');
const IDENTITY_MANIFEST_PATH = resolve(PROJECT_DIRECTORY, 'config/staging-identities.json');
const MIGRATION_DIRECTORY = resolve(PROJECT_DIRECTORY, 'supabase/migrations');
const EXPECTED_MIGRATIONS = Object.freeze([
  '0001_workspace_schema.sql',
  '0002_rls_storage_realtime.sql',
  '0003_task_realtime_actor.sql',
  '0004_realtime_scope_lockdown.sql',
  '0005_audit_immutability.sql',
  '0006_knowledge_contacts_search.sql',
  '0007_task5_integrity.sql',
  '0008_task5_taxonomy_recovery.sql',
  '0009_private_files_secure_items.sql',
  '0010_task6_ambiguous_file_cleanup.sql',
  '0011_task6_late_cleanup_safe_convergence.sql',
  '0012_task6_cleanup_retirement_canonical_safe.sql',
  '0013_task6_quarantine_tombstones_safe_parity.sql',
  '0014_task6_explicit_cleanup_success_safe_url.sql',
  '0015_task7_notifications_cleanup.sql',
  '0016_task7_cleanup.sql',
  '0017_task7_notification_replay.sql',
  '0018_task8_acceptance_security.sql',
  '0019_task8_upload_abuse_guards.sql',
]);
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

const CODES = Object.freeze({
  argumentsInvalid: 'STAGING_EVIDENCE_ARGUMENTS_INVALID',
  readFailed: 'STAGING_EVIDENCE_READ_FAILED',
  inputTooLarge: 'STAGING_EVIDENCE_INPUT_TOO_LARGE',
  jsonInvalid: 'STAGING_EVIDENCE_JSON_INVALID',
  duplicateKey: 'STAGING_EVIDENCE_DUPLICATE_KEY',
  outputFailed: 'STAGING_EVIDENCE_OUTPUT_FAILED',
  unsafeUrl: 'STAGING_EVIDENCE_UNSAFE_URL',
  unsafePath: 'STAGING_EVIDENCE_UNSAFE_PATH',
  likelySecret: 'STAGING_EVIDENCE_LIKELY_SECRET',
  likelyPan: 'STAGING_EVIDENCE_LIKELY_PAN',
  internalLanguage: 'STAGING_EVIDENCE_INTERNAL_LANGUAGE',
  structureInvalid: 'STAGING_EVIDENCE_STRUCTURE_INVALID',
  fingerprintCollision: 'STAGING_EVIDENCE_FINGERPRINT_COLLISION',
  timeInvalid: 'STAGING_EVIDENCE_TIME_INVALID',
  incomplete: 'STAGING_EVIDENCE_INCOMPLETE',
  nonPass: 'STAGING_EVIDENCE_NON_PASS',
  recoveryLimit: 'STAGING_EVIDENCE_RECOVERY_LIMIT',
  reviewInvalid: 'STAGING_EVIDENCE_REVIEW_INVALID',
  expectationInvalid: 'STAGING_EVIDENCE_EXPECTATION_INVALID',
  releaseMismatch: 'STAGING_EVIDENCE_RELEASE_MISMATCH',
  contourMismatch: 'STAGING_EVIDENCE_CONTOUR_MISMATCH',
  stale: 'STAGING_EVIDENCE_STALE',
  draftOk: 'STAGING_EVIDENCE_DRAFT_OK',
  candidateValid: 'STAGING_EVIDENCE_CANDIDATE_VALID',
});

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'state',
  'recordedAt',
  'validUntil',
  'release',
  'resources',
  'migration',
  'hostedChecks',
  'negativeCapabilities',
  'recovery',
  'approval',
]);

const RESOURCE_NAMES = Object.freeze([
  'github',
  'vercel',
  'supabaseStaging',
  'supabaseDrill',
  'telegram',
  's3Backup',
]);

const HOSTED_GATE_NAMES = Object.freeze([
  'rls',
  'realtime',
  'storage',
  'telegram',
  'vaultCron',
  'documentPipeline',
  'backup',
  'freshness',
  'restore',
  'nativeDevices',
  'security',
]);

const NATIVE_DEVICE_NAMES = Object.freeze(['ios', 'android', 'desktop', 'webA', 'webK']);

const NEGATIVE_GATE_NAMES = Object.freeze([
  'anonymousDataReadDenied',
  'crossWorkspaceReadDenied',
  'realtimeSendDenied',
  'publicRealtimeDenied',
  'storageWriteDenied',
  'otherBucketReadDenied',
  'forgedTelegramAuthDenied',
  'staleTelegramAuthDenied',
  'backupDatabaseWriteDenied',
  'backupStorageWriteDenied',
  'activeDocumentPublishDenied',
]);

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const REVISION_PATTERN = /^[0-9]{4}$/u;
const TIMESTAMP_PATTERN = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;

function result(code, ok = false, exitCode = 1) {
  return { code, ok, exitCode };
}

function parseArguments(argv) {
  let requireComplete = false;
  let filename = null;
  let output = null;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!positionalOnly && argument === '--') {
      positionalOnly = true;
    } else if (!positionalOnly && argument === '--require-complete') {
      if (requireComplete) return null;
      requireComplete = true;
    } else if (!positionalOnly && argument === '--file') {
      if (filename !== null || index + 1 >= argv.length) return null;
      filename = argv[index + 1];
      index += 1;
      if (filename.length === 0) return null;
    } else if (!positionalOnly && argument === '--output') {
      if (output !== null || index + 1 >= argv.length) return null;
      output = argv[index + 1];
      index += 1;
      if (output.length === 0) return null;
    } else if (!positionalOnly && argument.startsWith('-')) {
      return null;
    } else if (filename === null && argument.length > 0) {
      filename = argument;
    } else {
      return null;
    }
  }

  return filename === null ? null : { filename, output, requireComplete };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function sha256Fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

class InputTooLargeError extends Error {}

async function readRegularFile(filename, maximumBytes) {
  const descriptor = await open(
    filename,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const metadata = await descriptor.stat();
    if (!metadata.isFile()) throw new Error('invalid release input');
    if (metadata.size > maximumBytes) throw new InputTooLargeError('release input is too large');

    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const readResult = await descriptor.read(bytes, offset, bytes.byteLength - offset, offset);
      if (readResult.bytesRead === 0) break;
      offset += readResult.bytesRead;
    }
    if (offset > maximumBytes) throw new InputTooLargeError('release input is too large');
    return bytes.subarray(0, offset);
  } finally {
    await descriptor.close();
  }
}

function hasDuplicateJsonKeys(source) {
  let index = 0;

  const skipWhitespace = () => {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[index])) index += 1;
  };

  const readString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
      } else if (source[index] === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      } else {
        index += 1;
      }
    }
    throw new Error('invalid JSON string');
  };

  const readValue = () => {
    skipWhitespace();
    if (source[index] === '{') {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (source[index] === '}') {
        index += 1;
        return false;
      }
      while (index < source.length) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) return true;
        keys.add(key);
        skipWhitespace();
        index += 1;
        if (readValue()) return true;
        skipWhitespace();
        if (source[index] === '}') {
          index += 1;
          return false;
        }
        index += 1;
      }
    } else if (source[index] === '[') {
      index += 1;
      skipWhitespace();
      if (source[index] === ']') {
        index += 1;
        return false;
      }
      while (index < source.length) {
        if (readValue()) return true;
        skipWhitespace();
        if (source[index] === ']') {
          index += 1;
          return false;
        }
        index += 1;
      }
    } else if (source[index] === '"') {
      readString();
      return false;
    } else {
      while (index < source.length && !/[\u0009\u000a\u000d\u0020,\]}]/u.test(source[index])) {
        index += 1;
      }
      return false;
    }
    return false;
  };

  const duplicate = readValue();
  if (duplicate) return true;
  skipWhitespace();
  if (index !== source.length) throw new Error('invalid JSON document');
  return false;
}

function validIdentityManifest(manifest) {
  if (!hasExactKeys(manifest, IDENTITY_MANIFEST_KEYS)
    || manifest.schemaVersion !== 1 || manifest.configured !== true
    || typeof manifest.githubRepository !== 'string'
    || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(manifest.githubRepository)
    || typeof manifest.appOrigin !== 'string' || !manifest.appOrigin.startsWith('https://')
    || !/^[a-z0-9]{20}$/u.test(manifest.supabaseProjectRef)
    || !/^[a-z0-9]{20}$/u.test(manifest.supabaseDrillProjectRef)
    || manifest.supabaseProjectRef === manifest.supabaseDrillProjectRef
    || typeof manifest.telegramBotId !== 'string' || !/^\d{5,16}$/u.test(manifest.telegramBotId)
    || typeof manifest.telegramBotUsername !== 'string'
    || typeof manifest.telegramMiniAppShortName !== 'string'
    || typeof manifest.backupTargetEndpoint !== 'string'
    || typeof manifest.backupTargetBucket !== 'string'
    || typeof manifest.backupTargetPrefix !== 'string') return false;
  try {
    const appOrigin = new URL(manifest.appOrigin);
    const backupEndpoint = new URL(manifest.backupTargetEndpoint);
    return appOrigin.protocol === 'https:' && appOrigin.origin === manifest.appOrigin
      && appOrigin.pathname === '/' && !appOrigin.search && !appOrigin.hash
      && backupEndpoint.protocol === 'https:' && !backupEndpoint.username && !backupEndpoint.password
      && !backupEndpoint.search && !backupEndpoint.hash;
  } catch {
    return false;
  }
}

async function loadReleaseExpectations() {
  const expectedCommit = process.env.STAGING_RELEASE_COMMIT;
  if (typeof expectedCommit !== 'string' || !COMMIT_PATTERN.test(expectedCommit)) return null;
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_SHA !== expectedCommit) return null;

  try {
    const manifestSource = await readRegularFile(IDENTITY_MANIFEST_PATH, 16_384);
    const manifestText = manifestSource.toString('utf8');
    const manifest = JSON.parse(manifestText);
    if (manifestText !== `${JSON.stringify(manifest, null, 2)}\n`) return null;
    if (!validIdentityManifest(manifest)) return null;
    if (process.env.GITHUB_ACTIONS === 'true'
      && process.env.GITHUB_REPOSITORY !== manifest.githubRepository) return null;

    const entries = await readdir(MIGRATION_DIRECTORY, { withFileTypes: true });
    const migrationNames = entries
      .filter((entry) => entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
    if (migrationNames.length !== EXPECTED_MIGRATIONS.length
      || migrationNames.some((name, index) => name !== EXPECTED_MIGRATIONS[index])) return null;

    let migrationManifest = '';
    for (const name of migrationNames) {
      const contents = await readRegularFile(resolve(MIGRATION_DIRECTORY, name), 16 * 1024 * 1024);
      migrationManifest += `${name}\t${createHash('sha256').update(contents).digest('hex')}\n`;
    }

    return {
      commit: expectedCommit,
      revision: EXPECTED_MIGRATIONS.at(-1).slice(0, 4),
      migrationManifestSha256: sha256Fingerprint(migrationManifest),
      resources: {
        github: sha256Fingerprint(manifest.githubRepository),
        vercel: sha256Fingerprint(manifest.appOrigin),
        supabaseStaging: sha256Fingerprint([
          manifest.supabaseProjectRef,
          manifest.supabaseJwtKid,
          manifest.supabaseJwtPublicKeySpkiSha256,
        ].join('\n')),
        supabaseDrill: sha256Fingerprint(manifest.supabaseDrillProjectRef),
        telegram: sha256Fingerprint([
          manifest.telegramBotId,
          manifest.telegramBotUsername,
          manifest.telegramMiniAppShortName,
        ].join('\n')),
        s3Backup: sha256Fingerprint([
          manifest.backupTargetEndpoint,
          manifest.backupTargetBucket,
          manifest.backupTargetPrefix,
        ].join('\n')),
      },
    };
  } catch {
    return null;
  }
}

function isTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

function isSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isMeasurement(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validateGate(gate) {
  if (!hasExactKeys(gate, ['status', 'checkedAt', 'evidenceSha256'])) return false;
  if (gate.status === 'not-run') {
    return gate.checkedAt === null && gate.evidenceSha256 === null;
  }
  return (gate.status === 'pass' || gate.status === 'fail')
    && isTimestamp(gate.checkedAt)
    && isSha256(gate.evidenceSha256);
}

function validateHostedChecks(hostedChecks) {
  if (!hasExactKeys(hostedChecks, HOSTED_GATE_NAMES)) return false;
  for (const name of HOSTED_GATE_NAMES) {
    if (name === 'nativeDevices') continue;
    if (!validateGate(hostedChecks[name])) return false;
  }
  return hasExactKeys(hostedChecks.nativeDevices, NATIVE_DEVICE_NAMES)
    && NATIVE_DEVICE_NAMES.every((name) => validateGate(hostedChecks.nativeDevices[name]));
}

function validateNegativeCapabilities(negativeCapabilities) {
  return hasExactKeys(negativeCapabilities, NEGATIVE_GATE_NAMES)
    && NEGATIVE_GATE_NAMES.every((name) => validateGate(negativeCapabilities[name]));
}

function validateApproval(approval) {
  if (!hasExactKeys(approval, ['status', 'independent', 'reviewerFingerprint', 'approvedAt'])) {
    return false;
  }
  if (approval.status === 'pending') {
    return approval.independent === false
      && approval.reviewerFingerprint === null
      && approval.approvedAt === null;
  }
  if (approval.status === 'rejected') {
    return typeof approval.independent === 'boolean'
      && isSha256(approval.reviewerFingerprint)
      && approval.approvedAt === null;
  }
  if (approval.status === 'approved') {
    return typeof approval.independent === 'boolean'
      && isSha256(approval.reviewerFingerprint)
      && isTimestamp(approval.approvedAt);
  }
  return false;
}

function validateStructure(document) {
  if (!hasExactKeys(document, TOP_LEVEL_KEYS)) return false;
  if (document.schemaVersion !== 1 || (document.state !== 'draft' && document.state !== 'complete')) {
    return false;
  }
  if (!isNullableTimestamp(document.recordedAt) || !isNullableTimestamp(document.validUntil)) {
    return false;
  }
  if (!hasExactKeys(document.release, ['commit', 'deploymentStartedAt', 'deploymentCompletedAt'])) {
    return false;
  }
  if (!COMMIT_PATTERN.test(document.release.commit)
    || !isNullableTimestamp(document.release.deploymentStartedAt)
    || !isNullableTimestamp(document.release.deploymentCompletedAt)) {
    return false;
  }
  if (!hasExactKeys(document.resources, RESOURCE_NAMES)
    || !RESOURCE_NAMES.every((name) => isSha256(document.resources[name]))) {
    return false;
  }
  if (!hasExactKeys(document.migration, ['revision', 'manifestSha256', 'appliedAt'])
    || typeof document.migration.revision !== 'string'
    || !REVISION_PATTERN.test(document.migration.revision)
    || !isSha256(document.migration.manifestSha256)
    || !isNullableTimestamp(document.migration.appliedAt)) {
    return false;
  }
  if (!validateHostedChecks(document.hostedChecks)
    || !validateNegativeCapabilities(document.negativeCapabilities)) {
    return false;
  }
  if (!hasExactKeys(document.recovery, ['backupAgeHours', 'rpoHours', 'dataPlaneRtoHours'])
    || !isMeasurement(document.recovery.backupAgeHours)
    || !isMeasurement(document.recovery.rpoHours)
    || !isMeasurement(document.recovery.dataPlaneRtoHours)) {
    return false;
  }
  return validateApproval(document.approval);
}

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19 || /^(.)\1+$/u.test(digits)) return false;
  let total = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
    doubleDigit = !doubleDigit;
  }
  return total % 10 === 0;
}

function containsLikelyPan(value) {
  for (const match of value.matchAll(/(?:^|[^0-9])((?:[0-9][ -]?){12,18}[0-9])(?:[^0-9]|$)/gu)) {
    const digits = match[1].replace(/[ -]/gu, '');
    if (luhnValid(digits)) return true;
  }
  return false;
}

function containsLikelySecret(value) {
  if (SHA256_PATTERN.test(value) || COMMIT_PATTERN.test(value) || TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  if (/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/iu.test(value)) return true;
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(value)) return true;
  if (/\b(?:github_pat_|gh[pousr]_|glpat-|xox[baprs]-|sk-(?:proj-)?|sb_(?:secret|publishable)_)[A-Za-z0-9_-]{12,}\b/iu.test(value)) {
    return true;
  }
  if (/\b[0-9]{5,16}:[A-Za-z0-9_-]{20,}\b/u.test(value)) return true;
  if (/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u.test(value)) {
    return true;
  }
  if (/\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)\b\s*[:=]\s*\S+/iu.test(value)) {
    return true;
  }
  return value.length >= 32
    && /^[A-Za-z0-9_+=-]+$/u.test(value)
    && /[A-Z]/u.test(value)
    && /[a-z]/u.test(value)
    && /[0-9]/u.test(value);
}

function unsafeStringCode(value) {
  if (/(?:https?|postgres(?:ql)?|s3|file):\/\//iu.test(value)
    || /\b(?:[a-z0-9-]+\.)+(?:app|cloud|co|com|dev|invalid|io|net|org)\b/iu.test(value)) {
    return CODES.unsafeUrl;
  }
  if (containsLikelySecret(value)) return CODES.likelySecret;
  if (containsLikelyPan(value)) return CODES.likelyPan;
  if (/\b(?:TODO|FIXME|TBD|XXX)\b|ТЗ\s+закрыто|для\s+преподавателя|чек-?лист\s+требований|клиент\s+возьм[её]т|AI\/ChatGPT/iu.test(value)) {
    return CODES.internalLanguage;
  }
  if (/[\\/]/u.test(value)) return CODES.unsafePath;
  return null;
}

function findUnsafeContent(root) {
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      const code = unsafeStringCode(value);
      if (code !== null) return code;
    } else if (Array.isArray(value)) {
      for (const child of value) stack.push(child);
    } else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        const keyCode = unsafeStringCode(key);
        if (keyCode !== null) return keyCode;
        stack.push(child);
      }
    }
  }
  return null;
}

function allGates(document) {
  const gates = [];
  for (const name of HOSTED_GATE_NAMES) {
    if (name === 'nativeDevices') {
      for (const device of NATIVE_DEVICE_NAMES) gates.push(document.hostedChecks.nativeDevices[device]);
    } else {
      gates.push(document.hostedChecks[name]);
    }
  }
  for (const name of NEGATIVE_GATE_NAMES) gates.push(document.negativeCapabilities[name]);
  return gates;
}

function releaseMatchesExpectations(document, expectations) {
  return document.release.commit === expectations.commit
    && document.migration.revision === expectations.revision
    && document.migration.manifestSha256 === expectations.migrationManifestSha256;
}

function contourMatchesExpectations(document, expectations) {
  return RESOURCE_NAMES.every((name) => (
    document.resources[name] === expectations.resources[name]
  ));
}

function validatePresentChronology(document) {
  const startedAt = document.release.deploymentStartedAt;
  const completedAt = document.release.deploymentCompletedAt;
  if (startedAt !== null && completedAt !== null && Date.parse(startedAt) > Date.parse(completedAt)) {
    return false;
  }
  if (document.recordedAt !== null && document.validUntil !== null
    && Date.parse(document.recordedAt) >= Date.parse(document.validUntil)) {
    return false;
  }
  if (startedAt !== null && document.migration.appliedAt !== null
    && Date.parse(document.migration.appliedAt) > Date.parse(startedAt)) {
    return false;
  }
  return true;
}

function completeProblem(document, now) {
  const requiredTimestamps = [
    document.recordedAt,
    document.validUntil,
    document.release.deploymentStartedAt,
    document.release.deploymentCompletedAt,
    document.migration.appliedAt,
  ];
  const requiredMeasurements = [
    document.recovery.backupAgeHours,
    document.recovery.rpoHours,
    document.recovery.dataPlaneRtoHours,
  ];
  if (requiredTimestamps.some((value) => value === null)
    || requiredMeasurements.some((value) => value === null)
    || document.release.commit === '0'.repeat(40)
    || document.migration.revision === '0000') {
    return CODES.incomplete;
  }

  const gates = allGates(document);
  if (gates.some((gate) => gate.status === 'not-run')) return CODES.incomplete;
  if (gates.some((gate) => gate.status !== 'pass')) return CODES.nonPass;

  if (document.recovery.backupAgeHours > 26
    || document.recovery.rpoHours > 24
    || document.recovery.dataPlaneRtoHours > 4) {
    return CODES.recoveryLimit;
  }

  if (document.approval.status !== 'pending'
    || document.approval.independent !== false
    || document.approval.reviewerFingerprint !== null
    || document.approval.approvedAt !== null) {
    return CODES.reviewInvalid;
  }

  const startedAt = Date.parse(document.release.deploymentStartedAt);
  const completedAt = Date.parse(document.release.deploymentCompletedAt);
  const appliedAt = Date.parse(document.migration.appliedAt);
  const recordedAt = Date.parse(document.recordedAt);
  const validUntil = Date.parse(document.validUntil);
  const checkedTimes = gates.map((gate) => Date.parse(gate.checkedAt));
  const oldestCheckAt = Math.min(...checkedTimes);
  const lastCheckAt = Math.max(...checkedTimes);

  if (!(appliedAt <= startedAt
    && startedAt <= completedAt
    && completedAt <= Math.min(...checkedTimes)
    && lastCheckAt <= recordedAt
    && recordedAt < validUntil)) {
    return CODES.timeInvalid;
  }
  if (recordedAt > now + MAX_CLOCK_SKEW_MS
    || validUntil - recordedAt > MAX_VALIDITY_MS) {
    return CODES.timeInvalid;
  }
  if (now - oldestCheckAt > MAX_VALIDITY_MS) return CODES.stale;
  if (validUntil - oldestCheckAt > MAX_VALIDITY_MS) return CODES.timeInvalid;
  const elapsedSinceRecordingHours = Math.max(0, now - recordedAt - MAX_CLOCK_SKEW_MS)
    / (60 * 60 * 1_000);
  if (document.recovery.backupAgeHours + elapsedSinceRecordingHours > 26) {
    return CODES.stale;
  }
  const validityAfterRecordingHours = Math.max(0, validUntil - recordedAt)
    / (60 * 60 * 1_000);
  if (document.recovery.backupAgeHours + validityAfterRecordingHours > 26) {
    return CODES.timeInvalid;
  }
  if (validUntil <= now) return CODES.stale;
  return null;
}

async function validate(argv) {
  const options = parseArguments(argv);
  if (options === null) return result(CODES.argumentsInvalid, false, 2);

  let source;
  try {
    source = await readRegularFile(options.filename, MAX_INPUT_BYTES);
  } catch (error) {
    if (error instanceof InputTooLargeError) return result(CODES.inputTooLarge);
    return result(CODES.readFailed);
  }

  const sourceText = source.toString('utf8');
  let document;
  try {
    document = JSON.parse(sourceText);
  } catch {
    return result(CODES.jsonInvalid);
  }

  try {
    if (hasDuplicateJsonKeys(sourceText)) return result(CODES.duplicateKey);
  } catch {
    return result(CODES.jsonInvalid);
  }

  const unsafeCode = findUnsafeContent(document);
  if (unsafeCode !== null) return result(unsafeCode);
  if (!validateStructure(document)) return result(CODES.structureInvalid);

  const criticalFingerprints = [
    document.resources.supabaseStaging,
    document.resources.s3Backup,
    document.resources.supabaseDrill,
  ];
  if (new Set(criticalFingerprints).size !== criticalFingerprints.length) {
    return result(CODES.fingerprintCollision);
  }
  if (!validatePresentChronology(document)) return result(CODES.timeInvalid);

  if (options.requireComplete && document.state !== 'complete') return result(CODES.incomplete);
  if (document.state === 'complete') {
    const expectations = await loadReleaseExpectations();
    if (expectations === null) return result(CODES.expectationInvalid);
    if (!releaseMatchesExpectations(document, expectations)) return result(CODES.releaseMismatch);
    if (!contourMatchesExpectations(document, expectations)) return result(CODES.contourMismatch);
    const problem = completeProblem(document, Date.now());
    if (problem !== null) return result(problem);
  }

  if (options.output !== null) {
    if (resolve(options.output) === resolve(options.filename)) return result(CODES.outputFailed);
    try {
      await writeFile(options.output, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      return result(CODES.outputFailed);
    }
  }

  return options.requireComplete
    ? result(CODES.candidateValid, true, 0)
    : result(CODES.draftOk, true, 0);
}

let validationResult;
try {
  validationResult = await validate(process.argv.slice(2));
} catch {
  validationResult = result(CODES.structureInvalid);
}

const stream = validationResult.ok ? process.stdout : process.stderr;
stream.write(`${validationResult.code}\n`);
process.exitCode = validationResult.exitCode;
