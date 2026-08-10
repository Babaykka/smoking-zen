#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT = /^\d{8}T\d{6}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RETENTION_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1000;
const ROW_COUNT_KEYS = ['appUsers', 'workspaces', 'memberships', 'tasks', 'knowledgeItems', 'contacts', 'attachments'];

function fail() {
  throw new Error('Backup metadata validation failed.');
}

function flags(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value === undefined || parsed.has(key)) fail();
    parsed.set(key, value);
  }
  return parsed;
}

function required(options, key) {
  const value = options.get(key);
  if (!value) fail();
  return value;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) fail();
  return value;
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail();
  return milliseconds;
}

function objectPath(value) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 1024
    || value.startsWith('/') || value.endsWith('/') || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) fail();
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) fail();
  return value;
}

function canonicalHttpsEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value) || value.includes('%')) fail();
  const rawAuthorityAndPath = value.startsWith('https://') ? value.slice('https://'.length) : '';
  const rawSlash = rawAuthorityAndPath.indexOf('/');
  if (rawSlash >= 0) {
    let rawPath = rawAuthorityAndPath.slice(rawSlash + 1);
    if (rawPath.endsWith('/')) rawPath = rawPath.slice(0, -1);
    if (rawPath && rawPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) fail();
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail();
  let hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(hostname) || hostname.includes('..')) fail();
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) fail();
  const port = parsed.port && parsed.port !== '443' ? `:${parsed.port}` : '';
  const pathname = segments.length ? `/${segments.join('/')}` : '';
  return `https://${hostname}${port}${pathname}`;
}

function safeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail();
  return value;
}

function postgresServerVersion(value) {
  const versionNum = typeof value === 'string' && /^[1-9][0-9]{5}$/.test(value)
    ? Number(value) : value;
  if (!Number.isSafeInteger(versionNum) || versionNum < 100000 || versionNum > 999999) fail();
  return { versionNum, major: Math.floor(versionNum / 10000) };
}

function postgresClientVersion(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]?\.(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?$/.test(value)) fail();
  return { version: value, major: Number(value.slice(0, value.indexOf('.'))) };
}

function rowCountsDocument(value) {
  const counts = exactKeys(value, ROW_COUNT_KEYS);
  for (const key of ROW_COUNT_KEYS) safeInteger(counts[key]);
  if (counts.appUsers === 0 || counts.workspaces === 0 || counts.memberships === 0) fail();
  return Object.fromEntries(ROW_COUNT_KEYS.map((key) => [key, counts[key]]));
}

async function jsonFile(filename) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    fail();
  }
  return parsed;
}

async function privateJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  const handle = await open(filename, 'r+');
  try {
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function sha256(filename) {
  const bytes = await readFile(filename);
  return createHash('sha256').update(bytes).digest('hex');
}

function checksumDocument(value) {
  const document = exactKeys(value, ['schemaVersion', 'capturedAt', 'count', 'bytes', 'files']);
  if (document.schemaVersion !== 1) fail();
  instant(document.capturedAt);
  safeInteger(document.count);
  safeInteger(document.bytes);
  if (!Array.isArray(document.files) || document.files.length !== document.count) fail();
  const seen = new Set();
  let bytes = 0;
  const files = document.files.map((entry) => {
    exactKeys(entry, ['path', 'size', 'sha256']);
    const filePath = objectPath(entry.path);
    if (seen.has(filePath) || !SHA256.test(entry.sha256)) fail();
    seen.add(filePath);
    bytes += safeInteger(entry.size);
    if (!Number.isSafeInteger(bytes)) fail();
    return { path: filePath, size: entry.size, sha256: entry.sha256 };
  });
  if (bytes !== document.bytes) fail();
  if (files.some((entry, index) => index > 0 && files[index - 1].path >= entry.path)) fail();
  return { schemaVersion: 1, capturedAt: document.capturedAt, count: files.length, bytes, files };
}

function manifestDocument(value, expectedSnapshot) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const schemaVersion = value.schemaVersion;
  const document = exactKeys(value, schemaVersion === 2 ? [
    'schemaVersion', 'snapshotId', 'sourceProjectRef', 'schemaRevision', 'startedAt', 'oldestCaptureAt', 'completedAt', 'database', 'storage',
  ] : [
    'schemaVersion', 'snapshotId', 'startedAt', 'oldestCaptureAt', 'completedAt', 'database', 'storage',
  ]);
  if (![1, 2].includes(document.schemaVersion) || !SNAPSHOT.test(document.snapshotId)) fail();
  if (document.schemaVersion === 2
    && (typeof document.sourceProjectRef !== 'string' || !/^[a-z0-9]{20}$/u.test(document.sourceProjectRef))) fail();
  if (document.schemaVersion === 2 && document.schemaRevision !== '0017') fail();
  const snapshotAt = snapshotDate(document.snapshotId).getTime();
  if (expectedSnapshot && document.snapshotId !== expectedSnapshot) fail();
  const startedAt = instant(document.startedAt);
  const oldestCaptureAt = instant(document.oldestCaptureAt);
  const completedAt = instant(document.completedAt);
  if (snapshotAt !== startedAt) fail();
  if (startedAt > oldestCaptureAt || oldestCaptureAt > completedAt) fail();
  const database = exactKeys(document.database, document.schemaVersion === 2
    ? ['bytes', 'sha256', 'tocEntries', 'serverMajor', 'serverVersionNum', 'clientMajor', 'clientVersion', 'rowCounts']
    : ['bytes', 'sha256', 'tocEntries', 'rowCounts']);
  const storage = exactKeys(document.storage, ['count', 'bytes', 'checksumFileSha256']);
  if (safeInteger(database.bytes) === 0 || !SHA256.test(database.sha256)) fail();
  if (!Number.isSafeInteger(database.tocEntries) || database.tocEntries <= 0) fail();
  safeInteger(storage.count);
  safeInteger(storage.bytes);
  if (!SHA256.test(storage.checksumFileSha256)) fail();
  const databaseResult = {
    bytes: database.bytes,
    sha256: database.sha256,
    tocEntries: database.tocEntries,
    rowCounts: rowCountsDocument(database.rowCounts),
  };
  if (document.schemaVersion === 2) {
    const server = postgresServerVersion(database.serverVersionNum);
    const client = postgresClientVersion(database.clientVersion);
    if (database.serverMajor !== server.major || database.clientMajor !== client.major
      || server.major !== client.major) fail();
    Object.assign(databaseResult, {
      serverMajor: server.major,
      serverVersionNum: server.versionNum,
      clientMajor: client.major,
      clientVersion: client.version,
    });
  }
  return {
    schemaVersion: document.schemaVersion,
    snapshotId: document.snapshotId,
    ...(document.schemaVersion === 2 ? { sourceProjectRef: document.sourceProjectRef } : {}),
    ...(document.schemaVersion === 2 ? { schemaRevision: document.schemaRevision } : {}),
    startedAt: document.startedAt,
    oldestCaptureAt: document.oldestCaptureAt,
    completedAt: document.completedAt,
    database: databaseResult,
    storage: {
      count: storage.count, bytes: storage.bytes,
      checksumFileSha256: storage.checksumFileSha256,
    },
  };
}

async function walk(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    objectPath(child);
    if (entry.isSymbolicLink()) fail();
    if (entry.isDirectory()) files.push(...await walk(root, child));
    else if (entry.isFile()) files.push(child);
    else fail();
  }
  return files.sort();
}

async function inventory(options) {
  const raw = await jsonFile(required(options, '--input'));
  if (!Array.isArray(raw)) fail();
  const capturedAt = required(options, '--captured-at');
  instant(capturedAt);
  const seen = new Set();
  const files = raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail();
    const filePath = objectPath(entry.Path);
    if (seen.has(filePath)) fail();
    seen.add(filePath);
    return { path: filePath, size: safeInteger(entry.Size) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const bytes = files.reduce((total, file) => total + file.size, 0);
  if (!Number.isSafeInteger(bytes)) fail();
  await writeFile(required(options, '--paths'), files.map((file) => file.path).join('\n') + (files.length ? '\n' : ''), {
    encoding: 'utf8', mode: 0o600,
  });
  await privateJson(required(options, '--output'), { schemaVersion: 1, capturedAt, count: files.length, bytes, files });
}

async function hashTree(options) {
  const inventoryDoc = await jsonFile(required(options, '--inventory'));
  const inventoryValue = exactKeys(inventoryDoc, ['schemaVersion', 'capturedAt', 'count', 'bytes', 'files']);
  if (inventoryValue.schemaVersion !== 1 || !Array.isArray(inventoryValue.files)) fail();
  instant(inventoryValue.capturedAt);
  const root = required(options, '--root');
  const actualPaths = await walk(root);
  const expected = inventoryValue.files.map((entry) => {
    exactKeys(entry, ['path', 'size']);
    return { path: objectPath(entry.path), size: safeInteger(entry.size) };
  });
  if (expected.length !== safeInteger(inventoryValue.count)
    || actualPaths.length !== expected.length
    || actualPaths.some((filePath, index) => filePath !== expected[index].path)) fail();
  const files = [];
  let bytes = 0;
  for (const entry of expected) {
    const filename = path.join(root, entry.path);
    const stats = await lstat(filename);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== entry.size) fail();
    files.push({ ...entry, sha256: await sha256(filename) });
    bytes += entry.size;
  }
  if (bytes !== inventoryValue.bytes) fail();
  await privateJson(required(options, '--output'), {
    schemaVersion: 1, capturedAt: inventoryValue.capturedAt,
    count: files.length, bytes, files,
  });
}

async function verifyTree(options) {
  const checksums = checksumDocument(await jsonFile(required(options, '--checksums')));
  const root = required(options, '--root');
  const actual = await walk(root);
  if (actual.length !== checksums.files.length
    || actual.some((filePath, index) => filePath !== checksums.files[index].path)) fail();
  for (const entry of checksums.files) {
    const filename = path.join(root, entry.path);
    const stats = await lstat(filename);
    if (!stats.isFile() || stats.size !== entry.size || await sha256(filename) !== entry.sha256) fail();
  }
  process.stdout.write(`${JSON.stringify({ count: checksums.count, bytes: checksums.bytes, checksumVerified: true })}\n`);
}

async function createManifest(options) {
  const snapshotId = required(options, '--snapshot');
  if (!SNAPSHOT.test(snapshotId)) fail();
  const startedAt = required(options, '--started-at');
  const databaseCapturedAt = required(options, '--database-captured-at');
  const storageCapturedAt = required(options, '--storage-captured-at');
  const completedAt = required(options, '--completed-at');
  const times = [startedAt, databaseCapturedAt, storageCapturedAt, completedAt].map(instant);
  if (times[0] > times[1] || times[0] > times[2] || Math.max(times[1], times[2]) > times[3]) fail();
  const dump = required(options, '--dump');
  const dumpStats = await lstat(dump);
  if (!dumpStats.isFile() || dumpStats.size <= 0) fail();
  const tocLines = (await readFile(required(options, '--toc'), 'utf8'))
    .split(/\r?\n/).filter((line) => line.trim() && !line.startsWith(';'));
  if (tocLines.length === 0) fail();
  const checksumFilename = required(options, '--checksums');
  const checksums = checksumDocument(await jsonFile(checksumFilename));
  const rowCounts = rowCountsDocument(await jsonFile(required(options, '--rows')));
  const server = postgresServerVersion(required(options, '--server-version-num'));
  const client = postgresClientVersion(required(options, '--client-version'));
  const sourceProjectRef = required(options, '--source-project-ref');
  if (!/^[a-z0-9]{20}$/u.test(sourceProjectRef)) fail();
  if (server.major !== client.major) fail();
  const document = manifestDocument({
    schemaVersion: 2,
    snapshotId,
    sourceProjectRef,
    schemaRevision: '0017',
    startedAt,
    oldestCaptureAt: new Date(Math.min(times[1], times[2])).toISOString(),
    completedAt,
    database: {
      bytes: dumpStats.size,
      sha256: await sha256(dump),
      tocEntries: tocLines.length,
      serverMajor: server.major,
      serverVersionNum: server.versionNum,
      clientMajor: client.major,
      clientVersion: client.version,
      rowCounts,
    },
    storage: {
      count: checksums.count,
      bytes: checksums.bytes,
      checksumFileSha256: await sha256(checksumFilename),
    },
  }, snapshotId);
  await privateJson(required(options, '--output'), document);
}

function isoWeek(date) {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function snapshotDate(snapshotId) {
  if (!SNAPSHOT.test(snapshotId)) fail();
  const iso = `${snapshotId.slice(0, 4)}-${snapshotId.slice(4, 6)}-${snapshotId.slice(6, 8)}T${snapshotId.slice(9, 11)}:${snapshotId.slice(11, 13)}:${snapshotId.slice(13, 15)}.000Z`;
  const value = new Date(iso);
  if (!Number.isFinite(value.getTime()) || value.toISOString() !== iso) fail();
  return value;
}

async function retention(options) {
  const expectedSourceProjectRef = required(options, '--source-project-ref');
  if (!/^[a-z0-9]{20}$/u.test(expectedSourceProjectRef)) fail();
  let raw;
  if (options.has('--input')) {
    raw = await jsonFile(required(options, '--input'));
    if (!Array.isArray(raw)) fail();
  } else {
    const directory = required(options, '--directory');
    raw = [];
    for (const filename of (await readdir(directory)).sort()) {
      if (!filename.endsWith('.json')) continue;
      try {
        const expectedSnapshot = filename.slice(0, -5);
        if (!SNAPSHOT.test(expectedSnapshot)) continue;
        raw.push(manifestDocument(await jsonFile(path.join(directory, filename)), expectedSnapshot));
      } catch {
        // Incomplete or malformed snapshots are deliberately outside retention.
      }
    }
  }
  const now = instant(required(options, '--now'));
  const byId = new Map();
  for (const item of raw) {
    const manifest = manifestDocument(item);
    if (manifest.schemaVersion !== 2 || manifest.sourceProjectRef !== expectedSourceProjectRef) fail();
    // A small skew allowance prevents two healthy hosts from disagreeing at a
    // minute boundary, while a suspicious future completion aborts all purge.
    if (instant(manifest.startedAt) > now + RETENTION_CLOCK_SKEW_MILLISECONDS
      || instant(manifest.oldestCaptureAt) > now + RETENTION_CLOCK_SKEW_MILLISECONDS
      || instant(manifest.completedAt) > now + RETENTION_CLOCK_SKEW_MILLISECONDS) fail();
    byId.set(manifest.snapshotId, manifest);
  }
  const manifests = [...byId.values()].sort((a, b) => b.snapshotId.localeCompare(a.snapshotId));
  const keep = new Set(manifests.slice(0, 7).map((item) => item.snapshotId));
  const weeks = new Set();
  const months = new Set();
  for (const item of manifests) {
    const date = snapshotDate(item.snapshotId);
    const week = isoWeek(date);
    if (weeks.size < 4 && !weeks.has(week)) {
      weeks.add(week); keep.add(item.snapshotId);
    }
    const month = item.snapshotId.slice(0, 6);
    if (months.size < 12 && !months.has(month)) {
      months.add(month); keep.add(item.snapshotId);
    }
  }
  process.stdout.write(`${JSON.stringify({
    keep: [...keep].sort().reverse(),
    delete: manifests.map((item) => item.snapshotId).filter((id) => !keep.has(id)).sort(),
  })}\n`);
}

async function freshness(options) {
  const manifest = manifestDocument(await jsonFile(required(options, '--manifest')));
  const expectedSourceProjectRef = required(options, '--source-project-ref');
  if (!/^[a-z0-9]{20}$/u.test(expectedSourceProjectRef)
    || manifest.schemaVersion !== 2
    || manifest.sourceProjectRef !== expectedSourceProjectRef) fail();
  const now = instant(required(options, '--now'));
  const ageMilliseconds = now - instant(manifest.oldestCaptureAt);
  if (ageMilliseconds < 0) fail();
  const passed = ageMilliseconds <= 26 * 60 * 60 * 1000;
  process.stdout.write(`${JSON.stringify({ snapshotId: manifest.snapshotId, ageSeconds: Math.floor(ageMilliseconds / 1000), fresh: passed })}\n`);
  if (!passed) process.exitCode = 2;
}

async function validateManifest(options) {
  const document = manifestDocument(
    await jsonFile(required(options, '--manifest')),
    required(options, '--snapshot'),
  );
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

async function checksumPaths(options) {
  const checksums = checksumDocument(await jsonFile(required(options, '--checksums')));
  await writeFile(
    required(options, '--output'),
    checksums.files.map((file) => file.path).join('\n') + (checksums.files.length ? '\n' : ''),
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function verifyArtifacts(options) {
  const manifest = manifestDocument(
    await jsonFile(required(options, '--manifest')),
    required(options, '--snapshot'),
  );
  const dump = required(options, '--dump');
  const dumpStats = await lstat(dump);
  if (!dumpStats.isFile() || dumpStats.size !== manifest.database.bytes
    || await sha256(dump) !== manifest.database.sha256) fail();
  const tocEntries = (await readFile(required(options, '--toc'), 'utf8'))
    .split(/\r?\n/).filter((line) => line.trim() && !line.startsWith(';')).length;
  if (tocEntries !== manifest.database.tocEntries) fail();
  const checksumFilename = required(options, '--checksums');
  const checksums = checksumDocument(await jsonFile(checksumFilename));
  if (await sha256(checksumFilename) !== manifest.storage.checksumFileSha256
    || checksums.count !== manifest.storage.count || checksums.bytes !== manifest.storage.bytes) fail();
  process.stdout.write(`${JSON.stringify({
    databaseChecksumVerified: true,
    storageChecksumFileVerified: true,
    storageCount: checksums.count,
    storageBytes: checksums.bytes,
  })}\n`);
}

async function readyCheck(options) {
  const checksums = checksumDocument(await jsonFile(required(options, '--checksums')));
  const available = new Map(checksums.files.map((file) => [file.path, file]));
  const raw = await jsonFile(required(options, '--metadata'));
  if (!Array.isArray(raw)) fail();
  const seen = new Set();
  let previous = '';
  for (const value of raw) {
    const entry = exactKeys(value, ['path', 'size', 'sha256']);
    const filePath = objectPath(entry.path);
    const size = safeInteger(entry.size);
    if (!SHA256.test(entry.sha256) || seen.has(filePath) || (previous && previous >= filePath)) fail();
    seen.add(filePath); previous = filePath;
    const actual = available.get(filePath);
    if (!actual || actual.size !== size || actual.sha256 !== entry.sha256) fail();
  }
  process.stdout.write(`${JSON.stringify({
    readyAttachments: raw.length,
    allReadyAttachmentsPresent: true,
    readyAttachmentMetadataVerified: true,
  })}\n`);
}

async function evidence(options) {
  const manifest = manifestDocument(await jsonFile(required(options, '--manifest')));
  const startedAt = required(options, '--started-at');
  const completedAt = required(options, '--completed-at');
  const start = instant(startedAt);
  const end = instant(completedAt);
  if (end < start) fail();
  const rows = await jsonFile(required(options, '--rows'));
  exactKeys(rows, ['aggregateRows', 'rowCountsVerified']);
  safeInteger(rows.aggregateRows);
  if (rows.rowCountsVerified !== true) fail();
  const elapsedSeconds = Math.floor((end - start) / 1000);
  const captureAgeMilliseconds = start - instant(manifest.oldestCaptureAt);
  if (captureAgeMilliseconds < 0
    || captureAgeMilliseconds > 24 * 60 * 60 * 1000
    || elapsedSeconds > 4 * 60 * 60) fail();
  await privateJson(required(options, '--output'), {
    schemaVersion: 1,
    snapshotId: manifest.snapshotId,
    startedAt,
    completedAt,
    oldestCaptureAt: manifest.oldestCaptureAt,
    captureAgeSeconds: Math.floor(captureAgeMilliseconds / 1000),
    elapsedSeconds,
    aggregateRows: rows.aggregateRows,
    aggregateFiles: manifest.storage.count,
    businessRowCountsVerified: true,
    databaseChecksumVerified: true,
    storageChecksumsVerified: true,
    allReadyAttachmentsPresent: true,
    dataPlaneRpoWithin24Hours: true,
    dataPlaneRtoWithin4Hours: true,
  });
}

async function canonicalEndpoint(options) {
  process.stdout.write(`${canonicalHttpsEndpoint(required(options, '--value'))}\n`);
}

async function writePgCertificateAuthority(options) {
  const encoded = process.env.PG_CA_BASE64;
  if (typeof encoded !== 'string' || encoded.length < 16 || encoded.length > 32_768
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) fail();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) fail();
  const pem = bytes.toString('utf8');
  if (bytes.length > 24_576 || !/^(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n)+$/u.test(pem)
    || /[^\x0a\x20-\x7e]/u.test(pem)) fail();
  await writeFile(required(options, '--output'), pem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

const TOC_DESCRIPTIONS = [
  'PUBLICATION TABLES IN SCHEMA', 'MATERIALIZED VIEW DATA', 'SEQUENCE OWNED BY',
  'PUBLICATION TABLE', 'SUBSCRIPTION TABLE', 'DATABASE PROPERTIES', 'CHECK CONSTRAINT',
  'PROCEDURAL LANGUAGE', 'OPERATOR FAMILY', 'OPERATOR CLASS', 'DEFAULT ACL',
  'FOREIGN TABLE', 'MATERIALIZED VIEW', 'TABLE ATTACH', 'TABLE DATA', 'SEQUENCE SET',
  'FK CONSTRAINT', 'INDEX ATTACH', 'EVENT TRIGGER', 'ROW SECURITY', 'BLOB METADATA',
  'BLOB COMMENTS', 'ACCESS METHOD', 'SUBSCRIPTION', 'PUBLICATION', 'CONVERSION',
  'COLLATION', 'AGGREGATE', 'PROCEDURE', 'FUNCTION', 'CONSTRAINT', 'STATISTICS',
  'EXTENSION', 'SEQUENCE', 'DATABASE', 'SCHEMA', 'COMMENT', 'DEFAULT', 'TRIGGER',
  'POLICY', 'OPERATOR', 'DOMAIN', 'TYPE', 'TABLE', 'VIEW', 'INDEX', 'RULE', 'ACL',
  'BLOB DATA', 'BLOB', 'ENCODING', 'STDSTRINGS', 'SEARCHPATH',
].sort((left, right) => right.length - left.length);

async function validateToc(options) {
  const raw = await readFile(required(options, '--toc'), 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith(';'));
  if (lines.length === 0) fail();
  for (const line of lines) {
    const match = /^\d+;\s+\d+\s+\d+\s+(.+)$/.exec(line);
    if (!match) fail();
    const description = TOC_DESCRIPTIONS.find((candidate) => match[1].startsWith(`${candidate} `));
    if (!description) fail();
    const remainder = match[1].slice(description.length + 1);
    const namespace = remainder.split(/\s+/, 1)[0];
    if (namespace === 'public' || namespace === 'private') continue;
    if (namespace === '-' && ['ENCODING', 'STDSTRINGS', 'SEARCHPATH'].includes(description)) continue;
    if (namespace === '-' && ['SCHEMA', 'COMMENT', 'ACL'].includes(description)
      && /^(?:SCHEMA\s+)?(?:public|private)(?:\s|$)/.test(remainder.slice(2))) continue;
    fail();
  }
  process.stdout.write(`${JSON.stringify({ tocEntries: lines.length, schemas: ['private', 'public'] })}\n`);
}

async function restorePreflight(options) {
  const manifest = manifestDocument(await jsonFile(required(options, '--manifest')));
  const startedAt = instant(required(options, '--started-at'));
  const age = startedAt - instant(manifest.oldestCaptureAt);
  if (age < 0 || age > 24 * 60 * 60 * 1000) fail();
  process.stdout.write(`${JSON.stringify({ captureAgeSeconds: Math.floor(age / 1000), rpoWithin24Hours: true })}\n`);
}

async function postgresCompatibility(options) {
  const manifest = manifestDocument(await jsonFile(required(options, '--manifest')));
  if (manifest.schemaVersion !== 2) fail();
  if (manifest.sourceProjectRef !== required(options, '--source-project-ref')) fail();
  const target = postgresServerVersion(required(options, '--target-server-version-num'));
  const restore = postgresClientVersion(required(options, '--restore-client-version'));
  if (target.major !== manifest.database.serverMajor
    || restore.major !== manifest.database.clientMajor
    || target.major !== restore.major) fail();
  process.stdout.write(`${JSON.stringify({
    sourceServerMajor: manifest.database.serverMajor,
    dumpClientMajor: manifest.database.clientMajor,
    targetServerMajor: target.major,
    restoreClientMajor: restore.major,
    postgresMajorCompatible: true,
  })}\n`);
}

async function verifyRowCounts(options) {
  const manifest = manifestDocument(await jsonFile(required(options, '--manifest')));
  const actual = rowCountsDocument(await jsonFile(required(options, '--rows')));
  for (const key of ROW_COUNT_KEYS) {
    if (actual[key] !== manifest.database.rowCounts[key]) fail();
  }
  const aggregateRows = ROW_COUNT_KEYS.reduce((total, key) => total + actual[key], 0);
  safeInteger(aggregateRows);
  process.stdout.write(`${JSON.stringify({ aggregateRows, rowCountsVerified: true })}\n`);
}

const [command, ...values] = process.argv.slice(2);
const options = flags(values);
const commands = new Map([
  ['inventory', inventory],
  ['hash-tree', hashTree],
  ['verify-tree', verifyTree],
  ['manifest', createManifest],
  ['validate-manifest', validateManifest],
  ['checksum-paths', checksumPaths],
  ['verify-artifacts', verifyArtifacts],
  ['retention', retention],
  ['freshness', freshness],
  ['ready-check', readyCheck],
  ['evidence', evidence],
  ['canonical-endpoint', canonicalEndpoint],
  ['write-pg-ca', writePgCertificateAuthority],
  ['validate-toc', validateToc],
  ['restore-preflight', restorePreflight],
  ['postgres-compatibility', postgresCompatibility],
  ['verify-row-counts', verifyRowCounts],
]);

try {
  const handler = commands.get(command);
  if (!handler) fail();
  await handler(options);
} catch {
  process.stderr.write('Backup metadata validation failed.\n');
  process.exitCode = 1;
}
