#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031,SC2153

load test_helper

setup() {
  setup_fake_tools
  FRESHNESS_SCRIPT="$(project_root)/scripts/check-backup-freshness.sh"
  valid_backup_env
  export BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID=$BACKUP_TARGET_ACCESS_KEY_ID
  export BACKUP_FRESHNESS_TARGET_SECRET_ACCESS_KEY=$BACKUP_TARGET_SECRET_ACCESS_KEY
  unset BACKUP_TARGET_ACCESS_KEY_ID BACKUP_TARGET_SECRET_ACCESS_KEY
}

make_manifest() {
  local snapshot=$1
  local source_ref=${2:-abcdefghijklmnopqrst}
  local base="$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX/$snapshot"
  mkdir -p "$base"
  local instant="${snapshot:0:4}-${snapshot:4:2}-${snapshot:6:2}T${snapshot:9:2}:${snapshot:11:2}:${snapshot:13:2}.000Z"
  printf '{"schemaVersion":2,"snapshotId":"%s","sourceProjectRef":"%s","schemaRevision":"0019","startedAt":"%s","oldestCaptureAt":"%s","completedAt":"%s","database":{"bytes":1,"sha256":"%064d","tocEntries":1,"serverMajor":18,"serverVersionNum":180004,"clientMajor":18,"clientVersion":"18.4","rowCounts":{"appUsers":1,"workspaces":1,"memberships":1,"tasks":0,"knowledgeItems":0,"contacts":0,"attachments":0}},"storage":{"count":0,"bytes":0,"checksumFileSha256":"%064d"}}\n' \
    "$snapshot" "$source_ref" "$instant" "$instant" "$instant" 0 0 > "$base/manifest.json"
}

@test "freshness rejects a current-looking manifest from a foreign source project" {
  make_manifest 20260810T010203Z zyxwvutsrqponmlkjihg
  export FAKE_TARGET_DIRS=$'20260810T010203Z/\n'
  export FAKE_DATE_OUTPUT=20260810T020203Z
  run "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
}

@test "freshness rejects a legacy schema-v1 completion marker" {
  snapshot=20260810T010203Z
  base="$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX/$snapshot"
  mkdir -p "$base"
  printf '{"schemaVersion":1,"snapshotId":"%s","startedAt":"2026-08-10T01:02:03.000Z","oldestCaptureAt":"2026-08-10T01:02:03.000Z","completedAt":"2026-08-10T01:02:03.000Z","database":{"bytes":1,"sha256":"%064d","tocEntries":1,"rowCounts":{"appUsers":1,"workspaces":1,"memberships":1,"tasks":0,"knowledgeItems":0,"contacts":0,"attachments":0}},"storage":{"count":0,"bytes":0,"checksumFileSha256":"%064d"}}\n' \
    "$snapshot" 0 0 > "$base/manifest.json"
  export FAKE_TARGET_DIRS="$snapshot/"$'\n'
  export FAKE_DATE_OUTPUT=20260810T020203Z
  run "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
}

@test "freshness selects the newest valid completed snapshot and enforces 26 hours" {
  make_manifest 20260810T010203Z
  export FAKE_TARGET_DIRS=$'malformed/\n20260810T010203Z/\n'
  export FAKE_DATE_OUTPUT=20260811T030203Z
  run "$FRESHNESS_SCRIPT"
  [ "$status" -eq 0 ]
  export FAKE_DATE_OUTPUT=20260811T030204Z
  run "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
}

@test "freshness publishes private evidence with the exact manifest it validated" {
  make_manifest 20260810T010203Z
  export FAKE_TARGET_DIRS=$'20260810T010203Z/\n'
  export FAKE_DATE_OUTPUT=20260810T020203Z
  export BACKUP_FRESHNESS_EVIDENCE_OUTPUT="$TEST_ROOT/freshness-evidence.json"
  run "$FRESHNESS_SCRIPT"
  [ "$status" -eq 0 ]

  remote_manifest="$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX/20260810T010203Z/manifest.json"
  cmp "$remote_manifest" "$BACKUP_FRESHNESS_EVIDENCE_OUTPUT"
  mode=$(stat -f '%Lp' "$BACKUP_FRESHNESS_EVIDENCE_OUTPUT" 2>/dev/null || stat -c '%a' "$BACKUP_FRESHNESS_EVIDENCE_OUTPUT")
  [ "$mode" = 600 ]
}

@test "freshness rejects unsafe evidence destinations before provider access" {
  victim="$TEST_ROOT/victim.json"
  printf '%s\n' 'do-not-overwrite' > "$victim"
  link="$TEST_ROOT/evidence-link.json"
  ln -s "$victim" "$link"

  for destination in "$victim" "$link" "$TEST_ROOT/evidence"$'\n'"path.json"; do
    : > "$FAKE_LOG"
    valid_backup_env
    export BACKUP_FRESHNESS_TARGET_ACCESS_KEY_ID=$BACKUP_TARGET_ACCESS_KEY_ID
    export BACKUP_FRESHNESS_TARGET_SECRET_ACCESS_KEY=$BACKUP_TARGET_SECRET_ACCESS_KEY
    unset BACKUP_TARGET_ACCESS_KEY_ID BACKUP_TARGET_SECRET_ACCESS_KEY
    export BACKUP_FRESHNESS_EVIDENCE_OUTPUT="$destination"
    run "$FRESHNESS_SCRIPT"
    [ "$status" -ne 0 ]
    [ ! -s "$FAKE_LOG" ]
    [ "$(cat "$victim")" = 'do-not-overwrite' ]
  done
}

@test "freshness leaves no evidence when validation fails" {
  make_manifest 20260810T010203Z
  export FAKE_TARGET_DIRS=$'20260810T010203Z/\n'
  export FAKE_DATE_OUTPUT=20260811T030204Z
  export BACKUP_FRESHNESS_EVIDENCE_OUTPUT="$TEST_ROOT/freshness-evidence.json"
  run "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$BACKUP_FRESHNESS_EVIDENCE_OUTPUT" ]
}

@test "freshness removes evidence when SIGPIPE interrupts final success reporting" {
  make_manifest 20260810T010203Z
  export FAKE_TARGET_DIRS=$'20260810T010203Z/\n'
  export FAKE_DATE_OUTPUT=20260810T020203Z
  export BACKUP_FRESHNESS_EVIDENCE_OUTPUT="$TEST_ROOT/freshness-evidence.json"
  run bash -o pipefail -c '"$1" | head -n 0' _ "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$BACKUP_FRESHNESS_EVIDENCE_OUTPUT" ]
}

@test "freshness fails safely when no completed manifest exists" {
  export FAKE_TARGET_DIRS=$'not-a-snapshot/\n20260810T010203Z/\n'
  run "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" != *SECRET_SENTINEL* ]]
}

@test "freshness rejects a backup target in the Supabase failure domain before provider calls" {
  export BACKUP_TARGET_ENDPOINT='https://uvwxyzabcdefghijklmn.storage.supabase.co/storage/v1/s3'
  run "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -s "$FAKE_LOG" ]
}

@test "freshness cannot substitute deprecated coordinates for the exact backup target" {
  unset BACKUP_TARGET_ENDPOINT
  export BACKUP_FRESHNESS_TARGET_ENDPOINT='https://different.example/s3'
  run "$FRESHNESS_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -s "$FAKE_LOG" ]
}
