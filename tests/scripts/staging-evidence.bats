#!/usr/bin/env bats
# shellcheck disable=SC2016

setup() {
  SOURCE_ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  PROJECT_ROOT="$BATS_TEST_TMPDIR/staging-evidence-project"
  mkdir -p "$PROJECT_ROOT/scripts" "$PROJECT_ROOT/docs" "$PROJECT_ROOT/config" "$PROJECT_ROOT/supabase"
  cp "$SOURCE_ROOT/scripts/validate-staging-evidence.mjs" "$PROJECT_ROOT/scripts/validate-staging-evidence.mjs"
  cp "$SOURCE_ROOT/docs/staging-evidence.example.json" "$PROJECT_ROOT/docs/staging-evidence.example.json"
  cp "$SOURCE_ROOT/config/staging-identities.json" "$PROJECT_ROOT/config/staging-identities.json"
  cp -R "$SOURCE_ROOT/supabase/migrations" "$PROJECT_ROOT/supabase/migrations"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const filename = process.argv[1];
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    manifest.configured = true;
    writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$PROJECT_ROOT/config/staging-identities.json"
  VALIDATOR="$PROJECT_ROOT/scripts/validate-staging-evidence.mjs"
  EXAMPLE="$PROJECT_ROOT/docs/staging-evidence.example.json"
  EVIDENCE="$BATS_TEST_TMPDIR/staging-evidence.json"
  CANONICAL_EVIDENCE="$BATS_TEST_TMPDIR/staging-evidence.canonical.json"
  STAGING_RELEASE_COMMIT='abcdef0123456789abcdef0123456789abcdef01'
  GITHUB_ACTIONS=true
  GITHUB_SHA="$STAGING_RELEASE_COMMIT"
  GITHUB_REPOSITORY='example/smoking-zen'
  export PROJECT_ROOT STAGING_RELEASE_COMMIT GITHUB_ACTIONS GITHUB_SHA GITHUB_REPOSITORY
}

write_complete_evidence() {
  node - "$EVIDENCE" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const output = process.argv[2];
const now = Date.now();
const instant = (offsetMinutes) => new Date(now + offsetMinutes * 60_000).toISOString();
const sha = (character) => `sha256:${character.repeat(64)}`;
const fingerprint = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const manifest = JSON.parse(fs.readFileSync(path.join(process.env.PROJECT_ROOT, 'config/staging-identities.json'), 'utf8'));
const migrationDirectory = path.join(process.env.PROJECT_ROOT, 'supabase/migrations');
const migrationNames = fs.readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort();
let migrationManifest = '';
for (const name of migrationNames) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationDirectory, name))).digest('hex');
  migrationManifest += `${name}\t${digest}\n`;
}
const gate = (character) => ({
  status: 'pass',
  checkedAt: instant(-5),
  evidenceSha256: sha(character),
});

const document = {
  schemaVersion: 1,
  state: 'complete',
  recordedAt: instant(-1),
  validUntil: instant(60),
  release: {
    commit: process.env.STAGING_RELEASE_COMMIT,
    deploymentStartedAt: instant(-30),
    deploymentCompletedAt: instant(-10),
  },
  resources: {
    github: fingerprint(manifest.githubRepository),
    vercel: fingerprint(manifest.appOrigin),
    supabaseStaging: fingerprint([manifest.supabaseProjectRef, manifest.supabaseJwtKid, manifest.supabaseJwtPublicKeySpkiSha256].join('\n')),
    supabaseDrill: fingerprint(manifest.supabaseDrillProjectRef),
    telegram: fingerprint([manifest.telegramBotId, manifest.telegramBotUsername, manifest.telegramMiniAppShortName].join('\n')),
    s3Backup: fingerprint([manifest.backupTargetEndpoint, manifest.backupTargetBucket, manifest.backupTargetPrefix].join('\n')),
  },
  migration: {
    revision: '0019',
    manifestSha256: fingerprint(migrationManifest),
    appliedAt: instant(-40),
  },
  hostedChecks: {
    rls: gate('8'),
    realtime: gate('9'),
    storage: gate('a'),
    telegram: gate('b'),
    vaultCron: gate('c'),
    documentPipeline: gate('d'),
    backup: gate('e'),
    freshness: gate('f'),
    restore: gate('0'),
    nativeDevices: {
      ios: gate('1'),
      android: gate('2'),
      desktop: gate('3'),
      webA: gate('4'),
      webK: gate('5'),
    },
    security: gate('3'),
  },
  negativeCapabilities: {
    anonymousDataReadDenied: gate('4'),
    crossWorkspaceReadDenied: gate('5'),
    realtimeSendDenied: gate('6'),
    publicRealtimeDenied: gate('7'),
    storageWriteDenied: gate('8'),
    otherBucketReadDenied: gate('9'),
    forgedTelegramAuthDenied: gate('a'),
    staleTelegramAuthDenied: gate('b'),
    backupDatabaseWriteDenied: gate('c'),
    backupStorageWriteDenied: gate('d'),
    activeDocumentPublishDenied: gate('e'),
  },
  recovery: {
    backupAgeHours: 2.5,
    rpoHours: 2.5,
    dataPlaneRtoHours: 0.75,
  },
  approval: {
    status: 'pending',
    independent: false,
    reviewerFingerprint: null,
    approvedAt: null,
  },
};

fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
NODE
}

mutate_evidence() {
  local mutation=$1
  node - "$EVIDENCE" "$mutation" <<'NODE'
const fs = require('node:fs');
const filename = process.argv[2];
const mutate = Function('document', process.argv[3]);
const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
mutate(document);
fs.writeFileSync(filename, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
NODE
}

assert_safe_code() {
  [[ "$output" =~ ^[A-Z][A-Z0-9_]*$ ]]
}

@test "the redacted example is a valid draft but cannot authorize promotion" {
  run node "$VALIDATOR" "$EXAMPLE"
  [ "$status" -eq 0 ]
  [ "$output" = STAGING_EVIDENCE_DRAFT_OK ]

  run node "$VALIDATOR" --require-complete "$EXAMPLE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_INCOMPLETE ]
}

@test "complete fresh evidence produces a canonical candidate without claiming approval authority" {
  write_complete_evidence

  run node "$VALIDATOR" --require-complete --output "$CANONICAL_EVIDENCE" "$EVIDENCE"
  [ "$status" -eq 0 ]
  [ "$output" = STAGING_EVIDENCE_CANDIDATE_VALID ]
  [[ "$output" != *abcdef0123456789* ]]
  [ -f "$CANONICAL_EVIDENCE" ]
  run node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const source = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(source);
    process.exit(source === `${JSON.stringify(parsed, null, 2)}\n` ? 0 : 1);
  ' "$CANONICAL_EVIDENCE"
  [ "$status" -eq 0 ]

  run node "$VALIDATOR" "$EVIDENCE" --require-complete
  [ "$status" -eq 0 ]
  [ "$output" = STAGING_EVIDENCE_CANDIDATE_VALID ]
}

@test "duplicate JSON keys cannot hide unsafe bytes in a retained candidate" {
  write_complete_evidence
  node - "$EVIDENCE" <<'NODE'
const fs = require('node:fs');
const filename = process.argv[2];
  const source = fs.readFileSync(filename, 'utf8');
  const shadowed = source.replace(
    '"state": "complete"',
    '"\\u0073tate": "https://secret.example.invalid/token",\n  "state": "complete"',
  );
fs.writeFileSync(filename, shadowed, { mode: 0o600 });
NODE

  run node "$VALIDATOR" --require-complete --output "$CANONICAL_EVIDENCE" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_DUPLICATE_KEY ]
  [ ! -e "$CANONICAL_EVIDENCE" ]
  [[ "$output" != *secret.example* ]]
}

@test "validator reads only bounded regular evidence files and never overwrites output" {
  ln -s "$EXAMPLE" "$EVIDENCE"
  run node "$VALIDATOR" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_READ_FAILED ]

  rm "$EVIDENCE"
  mkfifo "$EVIDENCE"
  run node "$VALIDATOR" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_READ_FAILED ]

  rm "$EVIDENCE"
  node -e 'require("node:fs").writeFileSync(process.argv[1], Buffer.alloc(512 * 1024 + 1))' "$EVIDENCE"
  run node "$VALIDATOR" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_INPUT_TOO_LARGE ]

  write_complete_evidence
  run node "$VALIDATOR" --require-complete --output "$EVIDENCE" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_OUTPUT_FAILED ]

  printf '%s\n' sentinel > "$CANONICAL_EVIDENCE"
  run node "$VALIDATOR" --require-complete --output "$CANONICAL_EVIDENCE" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_OUTPUT_FAILED ]
  [ "$(cat "$CANONICAL_EVIDENCE")" = sentinel ]
}

@test "promotion is bound to the current commit migration manifest and staging contour" {
  local mutation expected
  while IFS='|' read -r mutation expected; do
    write_complete_evidence
    mutate_evidence "$mutation"
    run node "$VALIDATOR" --require-complete "$EVIDENCE"
    [ "$status" -ne 0 ]
    [ "$output" = "$expected" ]
  done <<'CASES'
document.release.commit="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"|STAGING_EVIDENCE_RELEASE_MISMATCH
document.migration.revision="0001"|STAGING_EVIDENCE_RELEASE_MISMATCH
document.migration.manifestSha256="sha256:"+"0".repeat(64)|STAGING_EVIDENCE_RELEASE_MISMATCH
document.resources.github="sha256:"+"0".repeat(64)|STAGING_EVIDENCE_CONTOUR_MISMATCH
document.resources.telegram="sha256:"+"0".repeat(64)|STAGING_EVIDENCE_CONTOUR_MISMATCH
CASES

  write_complete_evidence
  unset STAGING_RELEASE_COMMIT
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_EXPECTATION_INVALID ]
}

@test "evidence expectations reject a noncanonical passport with duplicate keys" {
  write_complete_evidence
  node - "$PROJECT_ROOT/config/staging-identities.json" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const filename = process.argv[2];
const source = readFileSync(filename, 'utf8');
const duplicate = source.replace(
  '  "supabaseProjectRef": "abcdefghijklmnopqrst",',
  '  "supabaseProjectRef": "uvwxyzabcdefghijklmn",\n  "supabaseProjectRef": "abcdefghijklmnopqrst",',
);
if (duplicate === source) process.exit(1);
writeFileSync(filename, duplicate);
NODE
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_EXPECTATION_INVALID ]
}

@test "promotion rejects incomplete non-pass and stale evidence" {
  write_complete_evidence
  mutate_evidence 'document.hostedChecks.rls.status="not-run"; document.hostedChecks.rls.checkedAt=null; document.hostedChecks.rls.evidenceSha256=null'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_INCOMPLETE ]

  write_complete_evidence
  mutate_evidence 'document.negativeCapabilities.storageWriteDenied.status="fail"'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_NON_PASS ]

  write_complete_evidence
  mutate_evidence 'const base=Date.now()-48*60*60*1000; const iso=(m)=>new Date(base+m*60000).toISOString(); document.migration.appliedAt=iso(0); document.release.deploymentStartedAt=iso(5); document.release.deploymentCompletedAt=iso(10); for (const gate of Object.values(document.hostedChecks)) { if (gate.ios) { for (const client of Object.values(gate)) client.checkedAt=iso(12); } else gate.checkedAt=iso(12); } for (const gate of Object.values(document.negativeCapabilities)) gate.checkedAt=iso(12); document.recordedAt=iso(14); document.validUntil=iso(72)'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_STALE ]
}

@test "new recordedAt cannot refresh year-old hosted checks" {
  write_complete_evidence
  mutate_evidence 'const base=Date.now()-365*24*60*60*1000; const iso=(m)=>new Date(base+m*60000).toISOString(); document.migration.appliedAt=iso(0); document.release.deploymentStartedAt=iso(5); document.release.deploymentCompletedAt=iso(10); for (const gate of Object.values(document.hostedChecks)) { if (gate.ios) { for (const client of Object.values(gate)) client.checkedAt=iso(12); } else gate.checkedAt=iso(12); } for (const gate of Object.values(document.negativeCapabilities)) gate.checkedAt=iso(12); document.recordedAt=new Date(Date.now()-60000).toISOString(); document.validUntil=new Date(Date.now()+60*60000).toISOString()'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_STALE ]
}

@test "validUntil cannot extend checks beyond their 26-hour freshness" {
  write_complete_evidence
  mutate_evidence 'const iso=(h)=>new Date(Date.now()+h*60*60*1000).toISOString(); document.migration.appliedAt=iso(-26); document.release.deploymentStartedAt=iso(-25.8); document.release.deploymentCompletedAt=iso(-25.5); for (const gate of Object.values(document.hostedChecks)) { if (gate.ios) { for (const client of Object.values(gate)) client.checkedAt=iso(-25); } else gate.checkedAt=iso(-25); } for (const gate of Object.values(document.negativeCapabilities)) gate.checkedAt=iso(-25); document.recordedAt=iso(-0.01); document.validUntil=iso(2)'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_TIME_INVALID ]
}

@test "backup age continues aging after evidence is recorded" {
  write_complete_evidence
  mutate_evidence 'const shift=(value)=>new Date(Date.parse(value)-7*60*60*1000).toISOString(); document.migration.appliedAt=shift(document.migration.appliedAt); document.release.deploymentStartedAt=shift(document.release.deploymentStartedAt); document.release.deploymentCompletedAt=shift(document.release.deploymentCompletedAt); for (const gate of Object.values(document.hostedChecks)) { if (gate.ios) { for (const client of Object.values(gate)) client.checkedAt=shift(client.checkedAt); } else gate.checkedAt=shift(gate.checkedAt); } for (const gate of Object.values(document.negativeCapabilities)) gate.checkedAt=shift(gate.checkedAt); document.recordedAt=shift(document.recordedAt); document.validUntil=new Date(Date.now()+60*60000).toISOString(); document.recovery.backupAgeHours=20'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_STALE ]
}

@test "validUntil cannot outlive the backup freshness window" {
  write_complete_evidence
  mutate_evidence 'document.recovery.backupAgeHours=25; document.validUntil=new Date(Date.now()+2*60*60*1000).toISOString()'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_TIME_INVALID ]
}

@test "promotion enforces backup age RPO and data-plane RTO boundaries" {
  write_complete_evidence
  mutate_evidence 'document.recovery.backupAgeHours=24; document.recovery.rpoHours=24; document.recovery.dataPlaneRtoHours=4'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -eq 0 ]

  for mutation in \
    'document.recovery.backupAgeHours=26.001' \
    'document.recovery.rpoHours=24.001' \
    'document.recovery.dataPlaneRtoHours=4.001'; do
    write_complete_evidence
    mutate_evidence "$mutation"
    run node "$VALIDATOR" --require-complete "$EVIDENCE"
    [ "$status" -ne 0 ]
    [ "$output" = STAGING_EVIDENCE_RECOVERY_LIMIT ]
  done
}

@test "source backup and drill resource fingerprints must be distinct" {
  for mutation in \
    'document.resources.s3Backup=document.resources.supabaseStaging' \
    'document.resources.supabaseDrill=document.resources.supabaseStaging' \
    'document.resources.supabaseDrill=document.resources.s3Backup'; do
    write_complete_evidence
    mutate_evidence "$mutation"
    run node "$VALIDATOR" "$EVIDENCE"
    [ "$status" -ne 0 ]
    [ "$output" = STAGING_EVIDENCE_FINGERPRINT_COLLISION ]
  done
}

@test "migration must finish before deployment begins" {
  write_complete_evidence
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -eq 0 ]

  mutate_evidence 'document.migration.appliedAt=document.hostedChecks.rls.checkedAt'
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_TIME_INVALID ]
}

@test "every canonical hosted native-device and negative-capability gate is mandatory" {
  for name in \
    rls realtime storage telegram vaultCron documentPipeline backup freshness restore security; do
    write_complete_evidence
    mutate_evidence "delete document.hostedChecks.$name"
    run node "$VALIDATOR" "$EVIDENCE"
    [ "$status" -ne 0 ]
    [ "$output" = STAGING_EVIDENCE_STRUCTURE_INVALID ]
  done

  for name in ios android desktop webA webK; do
    write_complete_evidence
    mutate_evidence "delete document.hostedChecks.nativeDevices.$name"
    run node "$VALIDATOR" "$EVIDENCE"
    [ "$status" -ne 0 ]
    [ "$output" = STAGING_EVIDENCE_STRUCTURE_INVALID ]
  done

  for name in \
    anonymousDataReadDenied crossWorkspaceReadDenied realtimeSendDenied publicRealtimeDenied \
    storageWriteDenied otherBucketReadDenied forgedTelegramAuthDenied staleTelegramAuthDenied \
    backupDatabaseWriteDenied backupStorageWriteDenied activeDocumentPublishDenied; do
    write_complete_evidence
    mutate_evidence "delete document.negativeCapabilities.$name"
    run node "$VALIDATOR" "$EVIDENCE"
    [ "$status" -ne 0 ]
    [ "$output" = STAGING_EVIDENCE_STRUCTURE_INVALID ]
  done
}

@test "candidate cannot self-assert independent approval authority" {
  write_complete_evidence
  run node "$VALIDATOR" --require-complete "$EVIDENCE"
  [ "$status" -eq 0 ]

  for mutation in \
    'document.approval.status="approved"; document.approval.independent=true; document.approval.reviewerFingerprint="sha256:"+"f".repeat(64); document.approval.approvedAt=new Date().toISOString()' \
    'document.approval.status="rejected"; document.approval.reviewerFingerprint="sha256:"+"f".repeat(64)' \
    'document.approval.status="approved"; document.approval.independent=false; document.approval.reviewerFingerprint="sha256:"+"f".repeat(64); document.approval.approvedAt=new Date().toISOString()'; do
    write_complete_evidence
    mutate_evidence "$mutation"
    run node "$VALIDATOR" --require-complete "$EVIDENCE"
    [ "$status" -ne 0 ]
    [ "$output" = STAGING_EVIDENCE_REVIEW_INVALID ]
  done
}

@test "validator rejects raw URLs paths likely credentials PANs and internal TODO language" {
  for mutation in \
    'document.state="https://secret.example.invalid/path"' \
    'document.state="/private/var/staging-evidence.json"' \
    'document.state=["eyJhbGciOiJIUzI1NiJ9","eyJzdWIiOiJzZW50aW5lbCJ9","signatureSENTINEL"].join(".")' \
    'document.state="123456789:AASecretTokenSENTINEL1234567890"' \
    'document.state="4242 4242 4242 4242"' \
    'document.state="TODO: publish this to users"' \
    'document.state="ТЗ закрыто для преподавателя"'; do
    write_complete_evidence
    mutate_evidence "$mutation"
    run node "$VALIDATOR" "$EVIDENCE"
    [ "$status" -ne 0 ]
    assert_safe_code
    [[ "$output" != *SENTINEL* ]]
    [[ "$output" != *secret.example* ]]
    [[ "$output" != *4242* ]]
  done
}

@test "validator rejects malformed structure and never reflects malformed input" {
  printf '%s\n' '{"secret":"SENTINEL_TOKEN_12345678901234567890"' > "$EVIDENCE"

  run node "$VALIDATOR" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_JSON_INVALID ]
  [[ "$output" != *SENTINEL* ]]

  write_complete_evidence
  mutate_evidence 'document.release.commit="abc"'
  run node "$VALIDATOR" "$EVIDENCE"
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_EVIDENCE_STRUCTURE_INVALID ]
}
