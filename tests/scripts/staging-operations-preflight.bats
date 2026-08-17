#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031,SC2163

setup() {
  PREFLIGHT_SOURCE="$BATS_TEST_DIRNAME/../../scripts/staging-operations-preflight.mjs"
  PREFLIGHT_PROJECT="$BATS_TEST_TMPDIR/staging-operations-preflight-project"
  rm -rf "$PREFLIGHT_PROJECT"
  mkdir -p "$PREFLIGHT_PROJECT/scripts" "$PREFLIGHT_PROJECT/config"
  cp "$PREFLIGHT_SOURCE" "$PREFLIGHT_PROJECT/scripts/staging-operations-preflight.mjs"
  PREFLIGHT="$PREFLIGHT_PROJECT/scripts/staging-operations-preflight.mjs"

  export STAGING_OPERATIONS_OPERATION='backup-dry-run'
  export STAGING_ACTUAL_GITHUB_REPOSITORY='example/smoking-zen'
  export BACKUP_SOURCE_PROJECT_REF='abcdefghijklmnopqrst'
  export BACKUP_SOURCE_ENDPOINT="https://$BACKUP_SOURCE_PROJECT_REF.storage.supabase.co/storage/v1/s3"
  export BACKUP_TARGET_ENDPOINT='https://archive.smoking-zen.example/s3'
  export BACKUP_TARGET_BUCKET='smoking-zen-staging-backups'
  export BACKUP_TARGET_PREFIX='staging/daily'
  export STAGING_OPERATIONS_RESTORE_SNAPSHOT_ID=''
  export STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT=''
  unset RESTORE_SOURCE_PROJECT_REF RESTORE_TARGET_PROJECT_REF RESTORE_ARCHIVE_ENDPOINT
  unset RESTORE_ARCHIVE_BUCKET RESTORE_ARCHIVE_PREFIX RESTORE_TARGET_ENDPOINT

  node - "$PREFLIGHT_PROJECT/config/staging-identities.json" <<'NODE'
const { writeFileSync } = require('node:fs');
const manifest = {
  schemaVersion: 1,
  configured: true,
  githubRepository: 'example/smoking-zen',
  appOrigin: 'https://staging.example.com',
  supabaseProjectRef: 'abcdefghijklmnopqrst',
  supabaseDrillProjectRef: 'zyxwvutsrqponmlkjihg',
  telegramBotId: '123456789',
  telegramBotUsername: 'smoking_zen_staging_bot',
  telegramMiniAppShortName: 'smoking_zen_staging',
  supabaseJwtKid: 'smoking-zen-staging-1',
  supabaseJwtPublicKeySpkiSha256: `sha256:${'a'.repeat(64)}`,
  backupTargetEndpoint: 'https://archive.smoking-zen.example/s3',
  backupTargetBucket: 'smoking-zen-staging-backups',
  backupTargetPrefix: 'staging/daily',
};
writeFileSync(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
}

assert_code_only_output() {
  local line
  [ "${#lines[@]}" -gt 0 ]
  for line in "${lines[@]}"; do
    [[ "$line" =~ ^STAGING_OPERATIONS_PREFLIGHT_(PASS|ERROR)_[0-9]{3}_[A-Z0-9_]+$ ]]
  done
}

valid_restore() {
  export STAGING_OPERATIONS_OPERATION='restore-drill'
  export RESTORE_SOURCE_PROJECT_REF="$BACKUP_SOURCE_PROJECT_REF"
  export RESTORE_TARGET_PROJECT_REF='zyxwvutsrqponmlkjihg'
  export RESTORE_ARCHIVE_ENDPOINT="$BACKUP_TARGET_ENDPOINT"
  export RESTORE_ARCHIVE_BUCKET="$BACKUP_TARGET_BUCKET"
  export RESTORE_ARCHIVE_PREFIX="$BACKUP_TARGET_PREFIX"
  export RESTORE_TARGET_ENDPOINT="https://$RESTORE_TARGET_PROJECT_REF.storage.supabase.co/storage/v1/s3"
  export STAGING_OPERATIONS_RESTORE_SNAPSHOT_ID='20260810T010203Z'
  export STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT="RESTORE_ISOLATED_TARGET:$RESTORE_TARGET_PROJECT_REF:$STAGING_OPERATIONS_RESTORE_SNAPSHOT_ID"
}

@test "accepts every non-restore operation only on the pinned staging contour" {
  for operation in backup-dry-run backup-snapshot freshness; do
    setup
    export STAGING_OPERATIONS_OPERATION="$operation"
    run node "$PREFLIGHT"
    [ "$status" -eq 0 ]
    assert_code_only_output
    [ "${lines[${#lines[@]} - 1]}" = 'STAGING_OPERATIONS_PREFLIGHT_PASS_007_COMPLETE' ]
  done
}

@test "fails closed when the checked-in identity passport is not configured" {
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.configured = false;
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
  ' "$PREFLIGHT_PROJECT/config/staging-identities.json"
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_OPERATIONS_PREFLIGHT_ERROR_002_IDENTITY_MANIFEST'* ]]
  assert_code_only_output
}

@test "operations preflight rejects a noncanonical passport with duplicate keys" {
  node - "$PREFLIGHT_PROJECT/config/staging-identities.json" <<'NODE'
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
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_OPERATIONS_PREFLIGHT_ERROR_002_IDENTITY_MANIFEST'* ]]
  assert_code_only_output
}

@test "binds repository, source project, and source endpoint to the passport" {
  local assignment
  for assignment in \
    'STAGING_ACTUAL_GITHUB_REPOSITORY=example/other' \
    'BACKUP_SOURCE_PROJECT_REF=uvwxyzabcdefghijklmn' \
    'BACKUP_SOURCE_ENDPOINT=https://uvwxyzabcdefghijklmn.storage.supabase.co/storage/v1/s3'; do
    setup
    export "$assignment"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    assert_code_only_output
  done
}

@test "binds the independent backup endpoint, bucket, and staging prefix" {
  local assignment
  for assignment in \
    'BACKUP_TARGET_ENDPOINT=https://other.example.com/s3' \
    'BACKUP_TARGET_ENDPOINT=https://abcdefghijklmnopqrst.supabase.co/archive' \
    'BACKUP_TARGET_BUCKET=other-staging-backups' \
    'BACKUP_TARGET_PREFIX=production/daily'; do
    setup
    export "$assignment"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    assert_code_only_output
  done
}

@test "accepts restore only for the pinned drill project and target-bound snapshot acknowledgement" {
  valid_restore
  run node "$PREFLIGHT"
  [ "$status" -eq 0 ]
  assert_code_only_output
  [ "${lines[${#lines[@]} - 1]}" = 'STAGING_OPERATIONS_PREFLIGHT_PASS_007_COMPLETE' ]

  for assignment in \
    'RESTORE_TARGET_PROJECT_REF=uvwxyzabcdefghijklmn' \
    'RESTORE_SOURCE_PROJECT_REF=uvwxyzabcdefghijklmn' \
    'RESTORE_TARGET_ENDPOINT=https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3' \
    'STAGING_OPERATIONS_RESTORE_SNAPSHOT_ID=bad' \
    'STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT=RESTORE_ISOLATED_TARGET'; do
    setup
    valid_restore
    export "$assignment"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    assert_code_only_output
  done
}

@test "rejects restore-only inputs for backup and freshness operations" {
  export STAGING_OPERATIONS_RESTORE_SNAPSHOT_ID='20260810T010203Z'
  export STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT='RESTORE_ISOLATED_TARGET:zyxwvutsrqponmlkjihg:20260810T010203Z'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_OPERATIONS_PREFLIGHT_ERROR_007_RESTORE_INPUTS'* ]]
  assert_code_only_output
}

@test "never prints contour values or supplied secret sentinels" {
  export BACKUP_SOURCE_PROJECT_REF='SOURCE_SECRET_SENTINEL'
  export STAGING_OPERATIONS_RESTORE_ACKNOWLEDGEMENT='ACK_SECRET_SENTINEL'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" != *'SOURCE_SECRET_SENTINEL'* ]]
  [[ "$output" != *'ACK_SECRET_SENTINEL'* ]]
  assert_code_only_output
}
