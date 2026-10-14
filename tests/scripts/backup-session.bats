#!/usr/bin/env bats
# shellcheck disable=SC2016

setup() {
  TEST_ROOT="$BATS_TEST_TMPDIR/runtime"
  SCRIPT_DIR="$TEST_ROOT/scripts"
  FAKE_BIN="$TEST_ROOT/bin"
  CALL_LOG="$TEST_ROOT/calls.log"
  mkdir -p "$SCRIPT_DIR" "$FAKE_BIN"
  cp "$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/run-production-backup.sh" "$SCRIPT_DIR/run-production-backup.sh" 2>/dev/null || true
  cp "$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/backup-metadata.mjs" "$SCRIPT_DIR/backup-metadata.mjs"
  printf '%s\n' '#!/usr/bin/env bash' \
    'set -Eeuo pipefail' \
    'printf "backup\n" >> "$CALL_LOG"' \
    '[[ ${BACKUP_SOURCE_SESSION_TOKEN:-} == *SESSION_SENTINEL* ]] || exit 9' \
    '[[ -z ${BACKUP_SOURCE_AUTH_EMAIL:-}${BACKUP_SOURCE_AUTH_PASSWORD:-} ]] || exit 9' > "$SCRIPT_DIR/backup.sh"
  printf '%s\n' '[[ ${FAIL_BACKUP:-0} != 1 ]] || exit 17' >> "$SCRIPT_DIR/backup.sh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'set -Eeuo pipefail' \
    'config=${2:-}; response=$(sed -n "s/^output = \"\(.*\)\"$/\1/p" "$config")' \
    'printf "curl:%s\n" "$config" >> "$CALL_LOG"' \
    'grep -qx "max-filesize = 16384" "$config" || exit 8' \
    'if [[ ${FAKE_AUTH_RESPONSE:-valid} == oversize ]]; then head -c 17000 /dev/zero | tr "\\0" x > "$response"; exit 0; fi' \
    'if [[ ${FAKE_AUTH_RESPONSE:-valid} == malformed ]]; then printf "{}\n" > "$response"; exit 0; fi' \
    'token="eyJhbGciOiJIUzI1NiJ9.SESSION_"; token+="SENTINEL.signature"' \
    'auth_user_id=${FAKE_AUTH_USER_ID:-11111111-1111-4111-8111-111111111111}' \
    'printf "{\"access_token\":\"%s\",\"token_type\":\"bearer\",\"expires_in\":3600,\"user\":{\"id\":\"%s\",\"email\":\"%s\"}}\n" "$token" "$auth_user_id" "$BACKUP_SOURCE_AUTH_EMAIL" > "$response"' > "$FAKE_BIN/curl"
  chmod +x "$SCRIPT_DIR/run-production-backup.sh" "$SCRIPT_DIR/backup.sh" "$FAKE_BIN/curl"
  : > "$CALL_LOG"
  export TEST_ROOT SCRIPT_DIR FAKE_BIN CALL_LOG
  export PATH="$FAKE_BIN:$PATH"
  export BACKUP_SOURCE_PROJECT_REF=abcdefghijklmnopqrst
  export BACKUP_SOURCE_ENDPOINT=https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3
  anon_header='eyJhbGciOiJIUzI1NiJ9'
  anon_body='ANON_SENTINEL.signature'
  export BACKUP_SOURCE_AUTH_ANON_KEY="${anon_header}.${anon_body}"
  export BACKUP_SOURCE_AUTH_EMAIL=backup-reader@example.invalid
  export BACKUP_SOURCE_AUTH_PASSWORD='long-auth-password-SENTINEL'
  export BACKUP_SOURCE_AUTH_USER_ID=11111111-1111-4111-8111-111111111111
}

@test "backup session removes private authentication scratch on success and backup failure" {
  run "$SCRIPT_DIR/run-production-backup.sh"
  [ "$status" -eq 0 ]
  scratch_config=$(sed -n 's/^curl://p' "$CALL_LOG")
  [ ! -e "${scratch_config%/*}" ]

  : > "$CALL_LOG"
  export FAIL_BACKUP=1
  run "$SCRIPT_DIR/run-production-backup.sh"
  [ "$status" -eq 17 ]
  scratch_config=$(sed -n 's/^curl://p' "$CALL_LOG")
  [ ! -e "${scratch_config%/*}" ]
}

@test "backup session validates identity and JWT-safe inputs before any network call" {
  for assignment in \
    'BACKUP_SOURCE_PROJECT_REF=bad"ref' \
    $'BACKUP_SOURCE_PROJECT_REF=abcdefghijklmnopqrs\n' \
    'BACKUP_SOURCE_AUTH_ANON_KEY=bad"key' \
    $'BACKUP_SOURCE_AUTH_ANON_KEY=header.payload\nsignature' \
    'BACKUP_SOURCE_AUTH_USER_ID=not-a-uuid' \
    'BACKUP_SOURCE_ENDPOINT=https://other.storage.supabase.co/storage/v1/s3'; do
    export "${assignment?}"
    run "$SCRIPT_DIR/run-production-backup.sh"
    [ "$status" -ne 0 ]
    [ ! -s "$CALL_LOG" ]
    export BACKUP_SOURCE_PROJECT_REF=abcdefghijklmnopqrst
    export BACKUP_SOURCE_ENDPOINT=https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3
    export BACKUP_SOURCE_AUTH_ANON_KEY="${anon_header}.${anon_body}"
    export BACKUP_SOURCE_AUTH_USER_ID=11111111-1111-4111-8111-111111111111
  done
}

@test "backup session binds the authenticated user to the configured storage policy identity" {
  export FAKE_AUTH_USER_ID=22222222-2222-4222-8222-222222222222
  run "$SCRIPT_DIR/run-production-backup.sh"
  [ "$status" -ne 0 ]
  [ "$(grep -c '^curl:' "$CALL_LOG")" -eq 1 ]
  run grep -q '^backup$' "$CALL_LOG"
  [ "$status" -ne 0 ]
}

@test "backup session parses a capped response privately and exports only the short-lived token" {
  run "$SCRIPT_DIR/run-production-backup.sh"
  [ "$status" -eq 0 ]
  [ "$(grep -c '^curl:' "$CALL_LOG")" -eq 1 ]
  [ "$(grep -c '^backup$' "$CALL_LOG")" -eq 1 ]
  [[ "$output" != *SESSION_SENTINEL* ]]
  [[ "$output" != *ANON_SENTINEL* ]]
  [[ "$output" != *long-auth-password* ]]
}

@test "backup session rejects oversized and malformed provider responses before backup" {
  for response in oversize malformed; do
    : > "$CALL_LOG"
    export FAKE_AUTH_RESPONSE=$response
    run "$SCRIPT_DIR/run-production-backup.sh"
    [ "$status" -ne 0 ]
    [ "$(grep -c '^curl:' "$CALL_LOG")" -eq 1 ]
    run grep -q '^backup$' "$CALL_LOG"
    [ "$status" -ne 0 ]
  done
}

@test "script tests do not depend on a developer-specific executable path" {
  needle='/Users/'
  needle+='owner'
  run grep -R "$needle" "$BATS_TEST_DIRNAME"
  [ "$status" -ne 0 ]
}
