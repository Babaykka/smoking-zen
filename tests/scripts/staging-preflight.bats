#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031

setup() {
  PREFLIGHT_SOURCE="$BATS_TEST_DIRNAME/../../scripts/staging-preflight.mjs"
  PREFLIGHT_PROJECT="$BATS_TEST_TMPDIR/staging-preflight-project"
  rm -rf "$PREFLIGHT_PROJECT"
  mkdir -p "$PREFLIGHT_PROJECT/scripts" "$PREFLIGHT_PROJECT/config"
  cp "$PREFLIGHT_SOURCE" "$PREFLIGHT_PROJECT/scripts/staging-preflight.mjs"
  PREFLIGHT="$PREFLIGHT_PROJECT/scripts/staging-preflight.mjs"
  PROJECT_REF='abcdefghijklmnopqrst'
  OTHER_PROJECT_REF='uvwxyzabcdefghijklmn'
  export PROJECT_REF OTHER_PROJECT_REF

  export APP_MODE='production'
  export DEPLOYMENT_ENVIRONMENT='staging'
  export STAGING_ACTUAL_GITHUB_REPOSITORY='example/smoking-zen'
  export APP_ORIGIN='https://staging.example.com'
  export STAGING_EXPECTED_APP_ORIGIN="$APP_ORIGIN"

  export SUPABASE_URL="https://$PROJECT_REF.supabase.co"
  export STAGING_EXPECTED_SUPABASE_PROJECT_REF="$PROJECT_REF"
  export SUPABASE_PUBLISHABLE_KEY='sb_publishable_browser_key'
  export SUPABASE_SERVICE_ROLE_KEY='sb_secret_server_key'

  export TELEGRAM_BOT_TOKEN='123456:telegram_bot_token_secret_sentinel_123456'
  export TELEGRAM_BOT_USERNAME='smoking_zen_staging_bot'
  export STAGING_EXPECTED_TELEGRAM_BOT_USERNAME="$TELEGRAM_BOT_USERNAME"
  export TELEGRAM_MINI_APP_SHORT_NAME='smoking_zen_staging'
  export STAGING_EXPECTED_TELEGRAM_MINI_APP_SHORT_NAME="$TELEGRAM_MINI_APP_SHORT_NAME"
  export TELEGRAM_WEBHOOK_SECRET='WEBHOOK_SECRET_SENTINEL_1234567890'
  export INTERNAL_JOB_SECRET='INTERNAL_JOB_SECRET_SENTINEL_12345'
  export SESSION_SECRET='SESSION_SECRET_SENTINEL_123456789012'
  export OWNER_TELEGRAM_ID='123456789'
  export WORKSPACE_NAME='Smoking Zen'

  SUPABASE_JWT_ES256_PRIVATE_KEY=$(node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
  ')
  export SUPABASE_JWT_ES256_PRIVATE_KEY
  export SUPABASE_JWT_KID='staging-es256-key'
  export STAGING_EXPECTED_SUPABASE_JWT_KID="$SUPABASE_JWT_KID"

  export BACKUP_SOURCE_PROJECT_REF="$PROJECT_REF"
  export BACKUP_SOURCE_ENDPOINT="https://$PROJECT_REF.storage.supabase.co/storage/v1/s3"
  export BACKUP_PGHOST="db.$PROJECT_REF.supabase.co"
  export BACKUP_PGPORT='5432'
  export BACKUP_PGDATABASE='postgres'
  export BACKUP_PGUSER='smoking_zen_backup_reader'
  export BACKUP_PGSSLMODE='verify-full'
  export BACKUP_SOURCE_BUCKET='workspace-files'
  export BACKUP_TARGET_ENDPOINT='https://archive.smoking-zen.example/s3'
  export BACKUP_TARGET_BUCKET='smoking-zen-staging-backups'
  export BACKUP_TARGET_PREFIX='staging/daily'

  export STAGING_VAULT_APP_ORIGIN="$APP_ORIGIN"
  export STAGING_VAULT_INTERNAL_JOB_SECRET="$INTERNAL_JOB_SECRET"
  unset RESTORE_SOURCE_PROJECT_REF
  unset SUPABASE_SELF_HOSTED_ORIGINS BITWARDEN_SELF_HOSTED_ORIGINS TELEGRAM_INIT_DATA_MAX_AGE_SECONDS

  STAGING_TEST_KEY_FINGERPRINT=$(node -e '
    const { createHash, createPrivateKey, createPublicKey } = require("node:crypto");
    const key = createPrivateKey(process.env.SUPABASE_JWT_ES256_PRIVATE_KEY);
    const spki = createPublicKey(key).export({ type: "spki", format: "der" });
    process.stdout.write(`sha256:${createHash("sha256").update(spki).digest("hex")}`);
  ')
  export STAGING_TEST_KEY_FINGERPRINT
  node - "$PREFLIGHT_PROJECT/config/staging-identities.json" <<'NODE'
const { writeFileSync } = require('node:fs');
const manifest = {
  schemaVersion: 1,
  configured: true,
  githubRepository: 'example/smoking-zen',
  appOrigin: process.env.APP_ORIGIN,
  supabaseProjectRef: process.env.PROJECT_REF,
  supabaseDrillProjectRef: 'zyxwvutsrqponmlkjihg',
  telegramBotId: '123456',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME,
  telegramMiniAppShortName: process.env.TELEGRAM_MINI_APP_SHORT_NAME,
  supabaseJwtKid: process.env.SUPABASE_JWT_KID,
  supabaseJwtPublicKeySpkiSha256: process.env.STAGING_TEST_KEY_FINGERPRINT,
  backupTargetEndpoint: process.env.BACKUP_TARGET_ENDPOINT,
  backupTargetBucket: process.env.BACKUP_TARGET_BUCKET,
  backupTargetPrefix: process.env.BACKUP_TARGET_PREFIX,
};
writeFileSync(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
NODE
}

assert_code_only_output() {
  local line
  [ "${#lines[@]}" -gt 0 ]
  for line in "${lines[@]}"; do
    [[ "$line" =~ ^STAGING_PREFLIGHT_(PASS|ERROR)_[0-9]{3}_[A-Z0-9_]+$ ]]
  done
}

@test "staging preflight accepts one fully pinned independent staging contour" {
  run node "$PREFLIGHT"
  [ "$status" -eq 0 ]
  assert_code_only_output
  [ "${lines[0]}" = 'STAGING_PREFLIGHT_PASS_001_APP_MODE' ]
  [ "${lines[${#lines[@]} - 1]}" = 'STAGING_PREFLIGHT_PASS_019_COMPLETE' ]
}

@test "staging preflight rejects every CLI argument before accepting the contour" {
  run node "$PREFLIGHT" --unexpected-argument
  [ "$status" -ne 0 ]
  [ "$output" = STAGING_PREFLIGHT_ERROR_000_ARGUMENTS ]
  assert_code_only_output
}

@test "staging preflight fails closed on mode environment or application origin drift" {
  for assignment in \
    'APP_MODE=demo' \
    'DEPLOYMENT_ENVIRONMENT=production' \
    'APP_ORIGIN=http://staging.example.com' \
    'APP_ORIGIN=https://other.example.com' \
    'STAGING_EXPECTED_APP_ORIGIN='; do
    setup
    export "${assignment?}"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    assert_code_only_output
  done
}

@test "version-controlled staging identity manifest is an independent trust anchor" {
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const filename = process.argv[1];
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    manifest.configured = false;
    writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$PREFLIGHT_PROJECT/config/staging-identities.json"
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_003_IDENTITY_MANIFEST'* ]]
  assert_code_only_output

  setup
  export STAGING_ACTUAL_GITHUB_REPOSITORY='example/other-repository'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_003_IDENTITY_MANIFEST'* ]]
  assert_code_only_output

  setup
  export APP_ORIGIN='https://production.example.com'
  export STAGING_EXPECTED_APP_ORIGIN="$APP_ORIGIN"
  export SUPABASE_URL="https://$OTHER_PROJECT_REF.supabase.co"
  export STAGING_EXPECTED_SUPABASE_PROJECT_REF="$OTHER_PROJECT_REF"
  export BACKUP_SOURCE_PROJECT_REF="$OTHER_PROJECT_REF"
  export BACKUP_SOURCE_ENDPOINT="https://$OTHER_PROJECT_REF.storage.supabase.co/storage/v1/s3"
  export BACKUP_PGHOST="db.$OTHER_PROJECT_REF.supabase.co"
  export TELEGRAM_BOT_USERNAME='smoking_zen_production_bot'
  export STAGING_EXPECTED_TELEGRAM_BOT_USERNAME="$TELEGRAM_BOT_USERNAME"
  export TELEGRAM_MINI_APP_SHORT_NAME='smoking_zen_production'
  export STAGING_EXPECTED_TELEGRAM_MINI_APP_SHORT_NAME="$TELEGRAM_MINI_APP_SHORT_NAME"
  export SUPABASE_JWT_KID='production-es256-key'
  export STAGING_EXPECTED_SUPABASE_JWT_KID="$SUPABASE_JWT_KID"
  export BACKUP_TARGET_ENDPOINT='https://production-backup.example.com/s3'
  export BACKUP_TARGET_BUCKET='smoking-zen-production-backups'
  export BACKUP_TARGET_PREFIX='staging/production-lookalike'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_004_APP_ORIGIN'* ]]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_005_SUPABASE_PROJECT'* ]]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_009_TELEGRAM_IDENTITY'* ]]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_010_BACKUP_TARGET_ENDPOINT'* ]]
  assert_code_only_output
}

@test "staging preflight rejects a noncanonical passport with duplicate keys" {
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
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_003_IDENTITY_MANIFEST'* ]]
  assert_code_only_output
}

@test "staging preflight pins the official Supabase project to every available source coordinate" {
  local assignment expected
  while IFS='|' read -r assignment expected; do
    setup
    export "${assignment?}"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"$expected"* ]]
    assert_code_only_output
  done <<CASES
SUPABASE_URL=https://$OTHER_PROJECT_REF.supabase.co|STAGING_PREFLIGHT_ERROR_005_SUPABASE_PROJECT
STAGING_EXPECTED_SUPABASE_PROJECT_REF=$OTHER_PROJECT_REF|STAGING_PREFLIGHT_ERROR_005_SUPABASE_PROJECT
BACKUP_SOURCE_PROJECT_REF=|STAGING_PREFLIGHT_ERROR_006_BACKUP_SOURCE_REF
BACKUP_SOURCE_PROJECT_REF=$OTHER_PROJECT_REF|STAGING_PREFLIGHT_ERROR_006_BACKUP_SOURCE_REF
RESTORE_SOURCE_PROJECT_REF=$OTHER_PROJECT_REF|STAGING_PREFLIGHT_ERROR_006_BACKUP_SOURCE_REF
BACKUP_SOURCE_ENDPOINT=|STAGING_PREFLIGHT_ERROR_007_BACKUP_SOURCE_STORAGE
BACKUP_SOURCE_ENDPOINT=https://$OTHER_PROJECT_REF.storage.supabase.co/storage/v1/s3|STAGING_PREFLIGHT_ERROR_007_BACKUP_SOURCE_STORAGE
BACKUP_PGHOST=|STAGING_PREFLIGHT_ERROR_008_BACKUP_SOURCE_POSTGRES
BACKUP_PGHOST=db.$OTHER_PROJECT_REF.supabase.co|STAGING_PREFLIGHT_ERROR_008_BACKUP_SOURCE_POSTGRES
BACKUP_PGUSER=smoking_zen_backup_reader.$OTHER_PROJECT_REF|STAGING_PREFLIGHT_ERROR_008_BACKUP_SOURCE_POSTGRES
CASES
}

@test "staging preflight requires the private source bucket" {
  unset BACKUP_SOURCE_BUCKET
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_018_BACKUP_SOURCE_BUCKET'* ]]
  assert_code_only_output
}

@test "staging preflight accepts a project-bound Supavisor session coordinate" {
  export BACKUP_PGHOST='aws-0-us-east-1.pooler.supabase.com'
  export BACKUP_PGUSER="smoking_zen_backup_reader.$PROJECT_REF"
  run node "$PREFLIGHT"
  [ "$status" -eq 0 ]
}

@test "staging preflight pins both Telegram public identifiers" {
  for assignment in \
    'TELEGRAM_BOT_USERNAME=smoking_zen_production_bot' \
    'STAGING_EXPECTED_TELEGRAM_BOT_USERNAME=smoking_zen_production_bot' \
    'TELEGRAM_MINI_APP_SHORT_NAME=smoking_zen_production' \
    'STAGING_EXPECTED_TELEGRAM_MINI_APP_SHORT_NAME=smoking_zen_production'; do
    setup
    export "${assignment?}"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    [[ "$output" == *'STAGING_PREFLIGHT_ERROR_009_TELEGRAM_IDENTITY'* ]]
    assert_code_only_output
  done
}

@test "staging preflight binds the Telegram token to the pinned bot id" {
  export TELEGRAM_BOT_TOKEN='654321:telegram_bot_token_secret_sentinel_123456'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_009_TELEGRAM_IDENTITY'* ]]
  assert_code_only_output
}

@test "staging preflight requires an independent non-Supabase backup target and staging prefix" {
  local assignment expected
  while IFS='|' read -r assignment expected; do
    setup
    export "${assignment?}"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"$expected"* ]]
    assert_code_only_output
  done <<CASES
BACKUP_TARGET_ENDPOINT=$BACKUP_SOURCE_ENDPOINT|STAGING_PREFLIGHT_ERROR_010_BACKUP_TARGET_ENDPOINT
BACKUP_TARGET_ENDPOINT=https://$OTHER_PROJECT_REF.storage.supabase.co/storage/v1/s3|STAGING_PREFLIGHT_ERROR_010_BACKUP_TARGET_ENDPOINT
BACKUP_TARGET_ENDPOINT=https://other-archive.example.com/s3|STAGING_PREFLIGHT_ERROR_010_BACKUP_TARGET_ENDPOINT
BACKUP_TARGET_ENDPOINT=http://archive.example.com/s3|STAGING_PREFLIGHT_ERROR_010_BACKUP_TARGET_ENDPOINT
BACKUP_TARGET_BUCKET=other-valid-staging-backups|STAGING_PREFLIGHT_ERROR_011_BACKUP_TARGET_BUCKET
BACKUP_TARGET_BUCKET=Bad/Bucket|STAGING_PREFLIGHT_ERROR_011_BACKUP_TARGET_BUCKET
BACKUP_TARGET_PREFIX=production/daily|STAGING_PREFLIGHT_ERROR_012_BACKUP_TARGET_PREFIX
BACKUP_TARGET_PREFIX=staging/../production|STAGING_PREFLIGHT_ERROR_012_BACKUP_TARGET_PREFIX
CASES
}

@test "staging preflight verifies a PKCS8 P-256 private key and the pinned kid" {
  SUPABASE_JWT_ES256_PRIVATE_KEY=$(node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
    process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
  ')
  export SUPABASE_JWT_ES256_PRIVATE_KEY
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_013_ES256_PRIVATE_KEY'* ]]

  setup
  SUPABASE_JWT_ES256_PRIVATE_KEY=$(node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
  ')
  export SUPABASE_JWT_ES256_PRIVATE_KEY
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_013_ES256_PRIVATE_KEY'* ]]

  setup
  export SUPABASE_JWT_KID='production-es256-key'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_014_ES256_KID'* ]]
}

@test "staging preflight requires and compares a complete Vault snapshot" {
  run node "$PREFLIGHT"
  [ "$status" -eq 0 ]

  export STAGING_VAULT_APP_ORIGIN='https://other.example.com'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_015_VAULT_ORIGIN'* ]]

  setup
  export STAGING_VAULT_INTERNAL_JOB_SECRET='DIFFERENT_JOB_SECRET_SENTINEL_1234'
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_016_VAULT_SECRET'* ]]

  setup
  unset STAGING_VAULT_APP_ORIGIN STAGING_VAULT_INTERNAL_JOB_SECRET
  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_015_VAULT_ORIGIN'* ]]
  [[ "$output" == *'STAGING_PREFLIGHT_ERROR_016_VAULT_SECRET'* ]]
}

@test "staging preflight applies remaining production environment rules" {
  local assignment
  for assignment in \
    'TELEGRAM_BOT_TOKEN=invalid' \
    'TELEGRAM_WEBHOOK_SECRET=short' \
    'INTERNAL_JOB_SECRET=short' \
    'SESSION_SECRET=short' \
    'SUPABASE_PUBLISHABLE_KEY=sb_secret_wrong_kind' \
    'SUPABASE_SERVICE_ROLE_KEY=sb_publishable_wrong_kind' \
    'OWNER_TELEGRAM_ID=0' \
    'TELEGRAM_INIT_DATA_MAX_AGE_SECONDS=3601' \
    'BITWARDEN_SELF_HOSTED_ORIGINS=http://vault.example'; do
    setup
    export "${assignment?}"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    [[ "$output" == *'STAGING_PREFLIGHT_ERROR_017_PRODUCTION_ENVIRONMENT'* ]]
    assert_code_only_output
  done
}

@test "staging preflight rejects predictable operation and session secrets" {
  local assignment
  for assignment in \
    'TELEGRAM_WEBHOOK_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    'INTERNAL_JOB_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
    'SESSION_SECRET=cccccccccccccccccccccccccccccccccccccccc'; do
    setup
    export "${assignment?}"
    if [[ $assignment == INTERNAL_JOB_SECRET=* ]]; then
      export STAGING_VAULT_INTERNAL_JOB_SECRET="$INTERNAL_JOB_SECRET"
    fi
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    [[ "$output" == *'STAGING_PREFLIGHT_ERROR_017_PRODUCTION_ENVIRONMENT'* ]]
    assert_code_only_output
  done
}

@test "legacy Supabase JWT keys require bound HS256 claims and a live lifetime" {
  make_legacy_key() {
    node - "$1" "$2" "$3" <<'NODE'
const [algorithm, issuer, expiryOffset] = process.argv.slice(2);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
process.stdout.write([
  encode({ alg: algorithm, typ: 'JWT' }),
  encode({ iss: issuer, role: 'anon', iat: now - 60, exp: now + Number(expiryOffset) }),
  's'.repeat(43),
].join('.'));
NODE
  }

  SUPABASE_PUBLISHABLE_KEY=$(make_legacy_key HS256 supabase 3600)
  export SUPABASE_PUBLISHABLE_KEY
  run node "$PREFLIGHT"
  [ "$status" -eq 0 ]

  local value
  for value in \
    "$(make_legacy_key none supabase 3600)" \
    "$(make_legacy_key HS256 attacker 3600)" \
    "$(make_legacy_key HS256 supabase -1)"; do
    setup
    export SUPABASE_PUBLISHABLE_KEY="$value"
    run node "$PREFLIGHT"
    [ "$status" -ne 0 ]
    [[ "$output" == *'STAGING_PREFLIGHT_ERROR_017_PRODUCTION_ENVIRONMENT'* ]]
    assert_code_only_output
  done
}

@test "staging preflight never emits injected secret sentinels on validation errors" {
  export STAGING_VAULT_APP_ORIGIN='https://vault-origin-secret-sentinel.example'
  export STAGING_VAULT_INTERNAL_JOB_SECRET='VAULT_JOB_SECRET_SENTINEL_1234567'
  export BACKUP_TARGET_ACCESS_KEY_ID='BACKUP_ACCESS_SECRET_SENTINEL'
  export BACKUP_TARGET_SECRET_ACCESS_KEY='BACKUP_TARGET_SECRET_SENTINEL'
  export SUPABASE_JWT_ES256_PRIVATE_KEY='PRIVATE_KEY_SECRET_SENTINEL'
  export APP_MODE='demo'

  run node "$PREFLIGHT"
  [ "$status" -ne 0 ]
  assert_code_only_output
  [[ "$output" != *'telegram_bot_token_secret_sentinel'* ]]
  [[ "$output" != *'WEBHOOK_SECRET_SENTINEL'* ]]
  [[ "$output" != *'INTERNAL_JOB_SECRET_SENTINEL'* ]]
  [[ "$output" != *'SESSION_SECRET_SENTINEL'* ]]
  [[ "$output" != *'BACKUP_ACCESS_SECRET_SENTINEL'* ]]
  [[ "$output" != *'BACKUP_TARGET_SECRET_SENTINEL'* ]]
  [[ "$output" != *'PRIVATE_KEY_SECRET_SENTINEL'* ]]
  [[ "$output" != *'VAULT_JOB_SECRET_SENTINEL'* ]]
}
