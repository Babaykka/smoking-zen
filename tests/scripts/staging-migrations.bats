#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031,SC2153,SC2317

load test_helper

setup() {
  SOURCE_ROOT=$(project_root)
  TEST_RUNTIME="$BATS_TEST_TMPDIR/staging-migrations"
  PROJECT_ROOT="$TEST_RUNTIME/project"
  FAKE_BIN="$TEST_RUNTIME/bin"
  FAKE_PSQL_ARGS="$TEST_RUNTIME/psql.args"
  FAKE_PSQL_CALLS="$TEST_RUNTIME/psql.calls"
  FAKE_PSQL_SQL="$TEST_RUNTIME/psql.sql"
  FAKE_TEMP_MODES="$TEST_RUNTIME/temp.modes"
  TMPDIR="$TEST_RUNTIME/tmp"
  export PROJECT_ROOT STAGING_SCRIPT TEST_RUNTIME FAKE_BIN FAKE_PSQL_ARGS
  export FAKE_PSQL_CALLS FAKE_PSQL_SQL FAKE_TEMP_MODES TMPDIR
  mkdir -p "$FAKE_BIN" "$TMPDIR" "$PROJECT_ROOT/scripts" "$PROJECT_ROOT/supabase" "$PROJECT_ROOT/config"
  cp "$SOURCE_ROOT/scripts/apply-staging-migrations.sh" "$PROJECT_ROOT/scripts/apply-staging-migrations.sh"
  cp -R "$SOURCE_ROOT/supabase/migrations" "$PROJECT_ROOT/supabase/migrations"
  cp "$SOURCE_ROOT/config/staging-identities.json" "$PROJECT_ROOT/config/staging-identities.json"
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const filename = process.argv[1];
    const manifest = JSON.parse(readFileSync(filename, "utf8"));
    manifest.configured = true;
    writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$PROJECT_ROOT/config/staging-identities.json"
  STAGING_SCRIPT="$PROJECT_ROOT/scripts/apply-staging-migrations.sh"
  : > "$FAKE_PSQL_CALLS"

  write_fake_git
  write_fake_psql
  export PATH="$FAKE_BIN:$PATH"
  valid_staging_env
}

write_fake_git() {
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -Eeuo pipefail' \
    'case " $* " in' \
    '  *" rev-parse "*) printf "%s\n" "$FAKE_GIT_HEAD" ;;' \
    '  *" status "*)' \
    '    if [[ -z ${FAKE_GIT_STATUS_PATH:-} || " $* " == *" ${FAKE_GIT_STATUS_PATH} "* ]]; then' \
    '      printf "%s" "${FAKE_GIT_STATUS:-}"' \
    '    fi' \
    '    ;;' \
    '  *) exit 31 ;;' \
    'esac' > "$FAKE_BIN/git"
  chmod +x "$FAKE_BIN/git"
}

write_fake_psql() {
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -Eeuo pipefail' \
    'printf "psql\n" >> "$FAKE_PSQL_CALLS"' \
    'printf "%s\n" "$@" > "$FAKE_PSQL_ARGS"' \
    'cat > "$FAKE_PSQL_SQL"' \
    '[[ ${PGHOST:-} == "$FAKE_EXPECTED_PGHOST" ]] || exit 41' \
    '[[ ${PGPORT:-} == 5432 && ${PGDATABASE:-} == postgres ]] || exit 42' \
    '[[ ${PGUSER:-} == "$FAKE_EXPECTED_PGUSER" ]] || exit 43' \
    '[[ ${PGPASSWORD:-} == "$FAKE_EXPECTED_PGPASSWORD" ]] || exit 44' \
    '[[ ${PGSSLMODE:-} == verify-full ]] || exit 45' \
    '[[ ${PGAPPNAME:-} == smoking-zen-staging-migrations ]] || exit 46' \
    '[[ -z ${PGHOSTADDR:-}${PGSERVICE:-}${PGSERVICEFILE:-}${PGOPTIONS:-}${PGPASSFILE:-} ]] || exit 47' \
    '[[ -z ${FAKE_EXPECTED_PGSSLROOTCERT:-} || ${PGSSLROOTCERT:-} == "$FAKE_EXPECTED_PGSSLROOTCERT" ]] || exit 49' \
    'for scratch in "$TMPDIR"/smoking-zen-staging-migrations.*; do' \
    '  [[ -d $scratch ]] || continue' \
    '  while IFS= read -r -d "" file; do' \
    '    stat -c "%a" "$file" 2>/dev/null || stat -f "%Lp" "$file"' \
    '  done < <(find "$scratch" -type f -print0)' \
    'done > "$FAKE_TEMP_MODES"' \
    'if [[ ${FAKE_PSQL_EXIT:-0} != 0 ]]; then' \
    '  printf "%s\n" "provider error: PROVIDER_SECRET_SENTINEL" >&2' \
    '  exit "$FAKE_PSQL_EXIT"' \
    'fi' \
    'if [[ -n ${FAKE_PSQL_RESULT+x} ]]; then' \
    '  printf "%s\n" "$FAKE_PSQL_RESULT"' \
    'else' \
    '  token=$(grep -Eo "STAGING_MIGRATIONS_OK:[0-9a-f]{64}:[0-9a-f]{40}" "$FAKE_PSQL_SQL" | tail -n 1)' \
    '  [[ -n $token ]] || exit 48' \
    '  printf "%s\n" "$token"' \
    'fi' > "$FAKE_BIN/psql"
  chmod +x "$FAKE_BIN/psql"
}

valid_staging_env() {
  export APP_MODE=production
  export DEPLOYMENT_ENVIRONMENT=staging
  export STAGING_EXPECTED_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst
  export STAGING_MIGRATION_ACKNOWLEDGEMENT="APPLY_STAGING_MIGRATIONS:$STAGING_EXPECTED_SUPABASE_PROJECT_REF"
  export STAGING_RELEASE_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  export STAGING_MIGRATION_MODE=apply
  export PGHOST=aws-0-eu-central-1.pooler.supabase.com
  export PGPORT=5432
  export PGDATABASE=postgres
  export PGUSER="postgres.$STAGING_EXPECTED_SUPABASE_PROJECT_REF"
  export PGPASSWORD='pg:password\\DB_SECRET_SENTINEL'
  export PGSSLMODE=verify-full
  export FAKE_GIT_HEAD="$STAGING_RELEASE_COMMIT"
  export FAKE_EXPECTED_PGHOST="$PGHOST"
  export FAKE_EXPECTED_PGUSER="$PGUSER"
  export FAKE_EXPECTED_PGPASSWORD="$PGPASSWORD"
  unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSFILE PGSSLROOTCERT
  unset FAKE_EXPECTED_PGSSLROOTCERT FAKE_GIT_STATUS FAKE_GIT_STATUS_PATH
  unset FAKE_PSQL_EXIT FAKE_PSQL_RESULT
}

assert_psql_not_called() {
  [ ! -s "$FAKE_PSQL_CALLS" ]
}

assert_runtime_redacted() {
  combined="$output"
  [[ ! -e "$FAKE_PSQL_ARGS" ]] || combined+=$(cat "$FAKE_PSQL_ARGS")
  [[ ! -e "$FAKE_PSQL_SQL" ]] || combined+=$(cat "$FAKE_PSQL_SQL")
  [[ "$combined" != *DB_SECRET_SENTINEL* ]]
  [[ "$combined" != *PROVIDER_SECRET_SENTINEL* ]]
  [[ "$combined" != *"$PGHOST"* ]]
  [[ "$combined" != *"$PGUSER"* ]]
  [[ "$combined" != *"$PROJECT_ROOT"* ]]
  [[ "$combined" != *"$TEST_RUNTIME"* ]]
}

make_fixture() {
  FIXTURE_ROOT="$TEST_RUNTIME/fixture"
  rm -rf "$FIXTURE_ROOT"
  mkdir -p "$FIXTURE_ROOT/scripts" "$FIXTURE_ROOT/supabase" "$FIXTURE_ROOT/config"
  cp "$STAGING_SCRIPT" "$FIXTURE_ROOT/scripts/apply-staging-migrations.sh"
  cp -R "$PROJECT_ROOT/supabase/migrations" "$FIXTURE_ROOT/supabase/migrations"
  cp "$PROJECT_ROOT/config/staging-identities.json" "$FIXTURE_ROOT/config/staging-identities.json"
  FIXTURE_SCRIPT="$FIXTURE_ROOT/scripts/apply-staging-migrations.sh"
}

@test "apply mode sends the exact ordered chain through one locked transaction" {
  run "$STAGING_SCRIPT"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = 'Staging migrations applied successfully.' ]
  [[ "${lines[1]}" =~ ^STAGING_MIGRATION_MANIFEST_SHA256:sha256:[0-9a-f]{64}$ ]]
  [ "$(wc -l < "$FAKE_PSQL_CALLS" | tr -d ' ')" -eq 1 ]

  expected_args=$'-X\n--no-password\n--single-transaction\n--quiet\n--tuples-only\n--no-align\n--set=ON_ERROR_STOP=1'
  [ "$(cat "$FAKE_PSQL_ARGS")" = "$expected_args" ]
  [ "$(grep -c '^-- smoking-zen migration: ' "$FAKE_PSQL_SQL")" -eq 19 ]
  [ "$(grep '^-- smoking-zen migration: ' "$FAKE_PSQL_SQL" | head -n 1)" = '-- smoking-zen migration: 0001_workspace_schema.sql' ]
  [ "$(grep '^-- smoking-zen migration: ' "$FAKE_PSQL_SQL" | tail -n 1)" = '-- smoking-zen migration: 0019_task8_upload_abuse_guards.sql' ]
  [ "$(grep -c '^\\if :smoking_zen_apply_' "$FAKE_PSQL_SQL")" -eq 19 ]

  grep -Fq 'pg_advisory_xact_lock' "$FAKE_PSQL_SQL"
  grep -Fq 'create table if not exists private.staging_migration_ledger' "$FAKE_PSQL_SQL"
  grep -Fq 'enable row level security' "$FAKE_PSQL_SQL"
  grep -Fq 'force row level security' "$FAKE_PSQL_SQL"
  grep -Fq 'revoke all privileges on table private.staging_migration_ledger' "$FAKE_PSQL_SQL"
  grep -Fq 'staging migration checksum drift' "$FAKE_PSQL_SQL"
  grep -Fq 'insert into private.staging_migration_releases' "$FAKE_PSQL_SQL"

  latest_sha=$(shasum -a 256 "$PROJECT_ROOT/supabase/migrations/0019_task8_upload_abuse_guards.sql" | awk '{print $1}')
  grep -Fq "0019_task8_upload_abuse_guards.sql'" "$FAKE_PSQL_SQL"
  grep -Fq "is distinct from '$latest_sha'" "$FAKE_PSQL_SQL"
  grep -Fq "to_regprocedure('public.claim_attachment_validation(uuid,uuid,text)')" "$FAKE_PSQL_SQL"
  grep -Fq "attname = 'validation_lease_id'" "$FAKE_PSQL_SQL"

  [ -s "$FAKE_TEMP_MODES" ]
  [ "$(sort -u "$FAKE_TEMP_MODES")" = 600 ]
  [ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ]
  assert_runtime_redacted
}

@test "fail-closed staging identity and target-bound acknowledgement checks run before psql" {
  for assignment in \
    'APP_MODE=staging' \
    'DEPLOYMENT_ENVIRONMENT=production' \
    'STAGING_MIGRATION_ACKNOWLEDGEMENT=APPLY_STAGING_MIGRATIONS' \
    'STAGING_MIGRATION_ACKNOWLEDGEMENT=APPLY_STAGING_MIGRATIONS:zyxwvutsrqponmlkjihg' \
    'STAGING_EXPECTED_SUPABASE_PROJECT_REF=bad-ref' \
    'STAGING_RELEASE_COMMIT=abc123' \
    'STAGING_MIGRATION_MODE=verify-full'; do
    valid_staging_env
    export "${assignment?}"
    : > "$FAKE_PSQL_CALLS"
    run "$STAGING_SCRIPT"
    [ "$status" -ne 0 ]
    assert_psql_not_called
    assert_runtime_redacted
  done
}

@test "version-controlled staging manifest anchors the migration project ref" {
  export STAGING_EXPECTED_SUPABASE_PROJECT_REF=zyxwvutsrqponmlkjihg
  export STAGING_MIGRATION_ACKNOWLEDGEMENT="APPLY_STAGING_MIGRATIONS:$STAGING_EXPECTED_SUPABASE_PROJECT_REF"
  export PGUSER="postgres.$STAGING_EXPECTED_SUPABASE_PROJECT_REF"
  export FAKE_EXPECTED_PGUSER="$PGUSER"
  run "$STAGING_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called
  assert_runtime_redacted
}

@test "migration runner rejects a noncanonical passport with duplicate keys" {
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
  run "$STAGING_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called
  assert_runtime_redacted
}

@test "project ref must match direct or session-pooler PG coordinates with verify-full" {
  for assignment in \
    'PGHOST=db.zyxwvutsrqponmlkjihg.supabase.co' \
    'PGHOST=evil.example' \
    'PGPORT=6543' \
    'PGDATABASE=template1' \
    'PGDATABASE=host=evil password=COORDINATE_SECRET_SENTINEL' \
    'PGUSER=postgres.zyxwvutsrqponmlkjihg' \
    'PGSSLMODE=require'; do
    valid_staging_env
    export "${assignment?}"
    : > "$FAKE_PSQL_CALLS"
    run "$STAGING_SCRIPT"
    [ "$status" -ne 0 ]
    assert_psql_not_called
    [[ "$output" != *COORDINATE_SECRET_SENTINEL* ]]
  done

  valid_staging_env
  export PGHOST="db.$STAGING_EXPECTED_SUPABASE_PROJECT_REF.supabase.co"
  export PGUSER=postgres
  export FAKE_EXPECTED_PGHOST="$PGHOST" FAKE_EXPECTED_PGUSER="$PGUSER"
  run "$STAGING_SCRIPT"
  [ "$status" -eq 0 ]
}

@test "libpq identity overrides and every CLI argument are rejected without leakage" {
  for assignment in \
    'PGHOSTADDR=203.0.113.9' \
    'PGSERVICE=evil' \
    'PGSERVICEFILE=/tmp/secret-service-file' \
    'PGOPTIONS=-c role=evil' \
    'PGPASSFILE=/tmp/secret-password-file'; do
    valid_staging_env
    export "${assignment?}"
    : > "$FAKE_PSQL_CALLS"
    run "$STAGING_SCRIPT"
    [ "$status" -ne 0 ]
    assert_psql_not_called
  done

  valid_staging_env
  run "$STAGING_SCRIPT" 'postgresql://postgres:CLI_SECRET_SENTINEL@evil/postgres'
  [ "$status" -ne 0 ]
  assert_psql_not_called
  [[ "$output" != *CLI_SECRET_SENTINEL* ]]
}

@test "a private verify-full CA is inherited through PG env and never added to arguments" {
  certificate_file="$TEST_RUNTIME/staging-root-ca.pem"
  printf '%s\n' '-----BEGIN CERTIFICATE-----' 'TEST' '-----END CERTIFICATE-----' \
    > "$certificate_file"
  chmod 600 "$certificate_file"
  export PGSSLROOTCERT="$certificate_file"
  export FAKE_EXPECTED_PGSSLROOTCERT="$certificate_file"

  run "$STAGING_SCRIPT"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = 'Staging migrations applied successfully.' ]
  [[ "${lines[1]}" =~ ^STAGING_MIGRATION_MANIFEST_SHA256:sha256:[0-9a-f]{64}$ ]]
  [[ "$(cat "$FAKE_PSQL_ARGS")" != *"$certificate_file"* ]]
  assert_runtime_redacted
}

@test "release commit must be the exact clean checkout commit" {
  export FAKE_GIT_HEAD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  run "$STAGING_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called
  assert_runtime_redacted

  valid_staging_env
  export FAKE_GIT_STATUS=' M supabase/migrations/0019_task8_upload_abuse_guards.sql'
  run "$STAGING_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called
  assert_runtime_redacted

  valid_staging_env
  export FAKE_GIT_STATUS=' M scripts/apply-staging-migrations.sh'
  export FAKE_GIT_STATUS_PATH='scripts/apply-staging-migrations.sh'
  run "$STAGING_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called
  assert_runtime_redacted
}

@test "inventory fails closed when a migration is missing renamed or added" {
  make_fixture
  rm "$FIXTURE_ROOT/supabase/migrations/0007_task5_integrity.sql"
  run "$FIXTURE_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called

  make_fixture
  mv "$FIXTURE_ROOT/supabase/migrations/0007_task5_integrity.sql" \
    "$FIXTURE_ROOT/supabase/migrations/0007_renamed.sql"
  run "$FIXTURE_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called

  make_fixture
  printf '%s\n' 'select 1;' > "$FIXTURE_ROOT/supabase/migrations/0020_unreviewed.sql"
  run "$FIXTURE_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called

  make_fixture
  printf '%s\n' 'select 1;' > "$FIXTURE_ROOT/supabase/migrations/.0020_hidden.sql"
  run "$FIXTURE_SCRIPT"
  [ "$status" -ne 0 ]
  assert_psql_not_called
  assert_runtime_redacted
}

@test "explicit reapply mode requires a complete ledger and executes all files again" {
  export STAGING_MIGRATION_MODE=reapply
  run "$STAGING_SCRIPT"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = 'Staging migrations reapplied and verified successfully.' ]
  [[ "${lines[1]}" =~ ^STAGING_MIGRATION_MANIFEST_SHA256:sha256:[0-9a-f]{64}$ ]]
  [ "$(grep -c '^-- smoking-zen migration: ' "$FAKE_PSQL_SQL")" -eq 19 ]
  run grep -q '^\\if :smoking_zen_apply_' "$FAKE_PSQL_SQL"
  [ "$status" -ne 0 ]
  grep -Fq 'reapply requires the complete current ledger' "$FAKE_PSQL_SQL"
  grep -Fq "'reapply'" "$FAKE_PSQL_SQL"
  assert_runtime_redacted
}

@test "psql errors keep provider output private and propagate the failing status" {
  export FAKE_PSQL_EXIT=27
  run "$STAGING_SCRIPT"
  [ "$status" -eq 27 ]
  [ "$output" = 'Staging migration operation failed.' ]
  [ "$(wc -l < "$FAKE_PSQL_CALLS" | tr -d ' ')" -eq 1 ]
  [ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ]
  assert_runtime_redacted
}

@test "an invalid postflight result fails closed without echoing psql output" {
  export FAKE_PSQL_RESULT='BAD_RESULT_WITH_DB_SECRET_SENTINEL'
  run "$STAGING_SCRIPT"
  [ "$status" -ne 0 ]
  [ "$output" = 'Staging migration operation failed.' ]
  [ "$(wc -l < "$FAKE_PSQL_CALLS" | tr -d ' ')" -eq 1 ]
  [[ "$output" != *DB_SECRET_SENTINEL* ]]
  [ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ]
}
