#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2153

load test_helper

setup() {
  setup_fake_tools
  RESTORE_SCRIPT="$(project_root)/scripts/restore-drill.sh"
  valid_restore_env
}

make_snapshot() {
  base="$FAKE_REMOTE_ROOT/$RESTORE_ARCHIVE_BUCKET/$RESTORE_ARCHIVE_PREFIX/$RESTORE_SNAPSHOT_ID"
  mkdir -p "$base/storage"
  printf 'fake-custom-dump\n' > "$base/database.dump"
  printf '{"schemaVersion":1,"capturedAt":"2026-08-10T01:02:03.000Z","count":0,"bytes":0,"files":[]}\n' > "$base/storage-checksums.json"
  db_sha=$(shasum -a 256 "$base/database.dump" | awk '{print $1}')
  checksum_sha=$(shasum -a 256 "$base/storage-checksums.json" | awk '{print $1}')
  db_bytes=$(wc -c < "$base/database.dump" | tr -d ' ')
  printf '{"schemaVersion":2,"snapshotId":"%s","sourceProjectRef":"%s","schemaRevision":"0019","startedAt":"2026-08-10T01:02:03.000Z","oldestCaptureAt":"2026-08-10T01:02:03.000Z","completedAt":"2026-08-10T01:03:03.000Z","database":{"bytes":%s,"sha256":"%s","tocEntries":2,"serverMajor":18,"serverVersionNum":180004,"clientMajor":18,"clientVersion":"18.4","rowCounts":{"appUsers":1,"workspaces":1,"memberships":1,"tasks":2,"knowledgeItems":1,"contacts":1,"attachments":0}},"storage":{"count":0,"bytes":0,"checksumFileSha256":"%s"}}\n' "$RESTORE_SNAPSHOT_ID" "$RESTORE_SOURCE_PROJECT_REF" "$db_bytes" "$db_sha" "$checksum_sha" > "$base/manifest.json"
}

@test "restore rejects a manifest labelled for a different source project before mutation" {
  make_snapshot
  manifest="$FAKE_REMOTE_ROOT/$RESTORE_ARCHIVE_BUCKET/$RESTORE_ARCHIVE_PREFIX/$RESTORE_SNAPSHOT_ID/manifest.json"
  node -e 'const fs=require("fs"),p=process.argv[1];const m=JSON.parse(fs.readFileSync(p));m.sourceProjectRef="uvwxyzabcdefghijklmn";fs.writeFileSync(p,JSON.stringify(m)+"\n")' "$manifest"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "restore rejects missing invalid id acknowledgement environment and same project before mutation" {
  for assignment in \
    'RESTORE_SNAPSHOT_ID=bad' \
    'RESTORE_TARGET_ENVIRONMENT=production' \
    'RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT=no' \
    'RESTORE_TARGET_PROJECT_REF=abcdefghijklmnopqrst' \
    'RESTORE_TARGET_PROJECT_REF=production'; do
    valid_restore_env; export "${assignment?}"
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
  done
  assert_no_external_mutation
}

@test "restore reads the archive with separate credentials and never requires the backup writer" {
  make_snapshot
  unset BACKUP_TARGET_ACCESS_KEY_ID BACKUP_TARGET_SECRET_ACCESS_KEY
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  combined="$output$(cat "$FAKE_LOG")"
  [[ "$combined" != *TARGET_SECRET_SENTINEL* ]]
  rm -f "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
}

@test "restore requires verify-full and a private valid target CA before mutation" {
  for assignment in \
    'RESTORE_PGSSLMODE=require' \
    'RESTORE_PGSSLROOTCERT_BASE64=not-base64' \
    'RESTORE_PGSSLROOTCERT_BASE64=YWJj'; do
    valid_restore_env; export "${assignment?}"
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
  done
  assert_no_external_mutation
}

@test "restore rejects libpq conninfo and URI identity overrides before any tool call" {
  for assignment in \
    'RESTORE_PGDATABASE=host=evil dbname=other password=DB_SECRET_SENTINEL' \
    'RESTORE_PGDATABASE=postgresql://user:DB_SECRET_SENTINEL@evil/other' \
    'RESTORE_PGUSER=user options=-c role=evil' \
    'RESTORE_PGHOST=host=evil'; do
    valid_restore_env; export "${assignment?}"
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output$(cat "$FAKE_LOG")" != *DB_SECRET_SENTINEL* ]]
  done
  [ ! -s "$FAKE_LOG" ]
}

@test "restore rejects failed DB guard and nonempty target Storage before mutation" {
  make_snapshot
  export FAKE_GUARD=f
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  assert_no_external_mutation
  export FAKE_GUARD=t FAKE_RESTORE_TARGET_LIST=$'existing-object\n'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  assert_no_external_mutation
}

@test "restore rejects target server or pg_restore major mismatch with the manifest before mutation" {
  make_snapshot
  export FAKE_SERVER_VERSION_NUM=170010
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]

  valid_restore_env
  : > "$FAKE_LOG"
  make_snapshot
  export FAKE_PG_RESTORE_VERSION=17.10
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "restore rejects a nonempty target DB and checks emptiness again immediately before mutation" {
  make_snapshot
  export FAKE_DB_EMPTY=f
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  export FAKE_DB_EMPTY=t
  : > "$FAKE_LOG"
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'smoking_zen_restore_target_empty' "$FAKE_LOG")" -eq 2 ]
  rm -f "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
}

@test "restore rejects missing or mismatched artifacts before DB or Storage mutation" {
  make_snapshot
  printf 'tampered\n' >> "$FAKE_REMOTE_ROOT/$RESTORE_ARCHIVE_BUCKET/$RESTORE_ARCHIVE_PREFIX/$RESTORE_SNAPSHOT_ID/database.dump"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "restore rejects malformed manifest and checksum aggregate mismatches before mutation" {
  make_snapshot
  base="$FAKE_REMOTE_ROOT/$RESTORE_ARCHIVE_BUCKET/$RESTORE_ARCHIVE_PREFIX/$RESTORE_SNAPSHOT_ID"
  cp "$base/manifest.json" "$TEST_ROOT/valid-manifest.json"
  printf '{"schemaVersion":1}\n' > "$base/manifest.json"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  : > "$FAKE_LOG"
  cp "$TEST_ROOT/valid-manifest.json" "$base/manifest.json"
  node -e 'const fs=require("fs"),p=process.argv[1];const m=JSON.parse(fs.readFileSync(p));m.storage.count=1;fs.writeFileSync(p,JSON.stringify(m)+"\n")' "$base/manifest.json"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "restore rejects an out-of-scope archive TOC before mutation" {
  make_snapshot
  export FAKE_TOC=$'; archive\n1; 0 0 TABLE auth users postgres\n2; 0 0 TABLE DATA auth users postgres\n'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "restore verifies everything before exact pg_restore then Storage and writes redacted private evidence last" {
  make_snapshot
  export FAKE_ASSERT_PG_CA=1
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  grep -q 'pg_restore .*<--exit-on-error>.*<--clean>.*<--if-exists>.*<--no-owner>.*<--no-privileges>.*<--no-password>.*<--single-transaction>' "$FAKE_LOG"
  grep -q 'pg_restore .*<--schema=public>.*<--schema=private>' "$FAKE_LOG"
  restore_line=$(grep -n '^pg_restore .*--clean' "$FAKE_LOG" | cut -d: -f1)
  hardening_line=$(grep -n 'psql .*restore_acl_0019.sql' "$FAKE_LOG" | cut -d: -f1)
  storage_line=$(grep -n '^rclone <copy>' "$FAKE_LOG" | tail -1 | cut -d: -f1)
  [ "$restore_line" -lt "$hardening_line" ]
  [ "$hardening_line" -lt "$storage_line" ]
  evidence="$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
  [ -f "$evidence" ]
  mode=$(stat -c '%a' "$evidence" 2>/dev/null || stat -f '%Lp' "$evidence")
  [ "$mode" = 600 ]
  [ ! -e "$(cat "$FAKE_CAPTURE_PGSSLROOTCERT")" ]
  content=$(cat "$evidence")
  [[ "$content" == *'"dataPlaneRpoWithin24Hours":true'* ]]
  [[ "$content" == *'"dataPlaneRtoWithin4Hours":true'* ]]
  [[ "$content" != *'"rtoWithin4Hours"'* ]]
  [[ "$content" != *SECRET_SENTINEL* ]]
  rm -f "$evidence"
}

@test "restore applies only the revision-matched ACL hardening and fails closed on ACL drift before Storage" {
  make_snapshot
  export FAKE_ACL_GUARD=f
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(grep -c 'psql .*restore_acl_0019.sql' "$FAKE_LOG")" -eq 1 ]
  run grep -q 'psql .*supabase/migrations/' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore proves ACL hardening did not mutate any public business row before Storage" {
  make_snapshot
  export FAKE_BUSINESS_DIGEST_AFTER=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(grep -c smoking_zen_business_digest "$FAKE_LOG")" -eq 2 ]
  run grep -q '^rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore scrubs inherited libpq routing and session variables" {
  make_snapshot
  export FAKE_ASSERT_PG_SCRUB=1
  export PGHOSTADDR='PG_SECRET_SENTINEL' PGOPTIONS='-c smoking_zen.restore_drill=true' \
    PGSERVICE='attacker' PGSERVICEFILE='/attacker' PGPASSWORD='PG_SECRET_SENTINEL'
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output$(cat "$FAKE_LOG")" != *PG_SECRET_SENTINEL* ]]
  rm -f "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
}

@test "restore accepts canonical Supabase S3 base paths" {
  make_snapshot
  export BACKUP_SOURCE_ENDPOINT='https://ABCDEFGHIJKLMNOPQRST.storage.supabase.co:443/storage/v1/s3/'
  export RESTORE_ARCHIVE_ENDPOINT='https://archive.example/backups/s3'
  export RESTORE_TARGET_ENDPOINT='https://ZYXWVUTSRQPONMLKJIHG.storage.supabase.co:443/storage/v1/s3/'
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  rm -f "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
}

@test "restore DB failure prevents Storage and success evidence" {
  make_snapshot
  export FAKE_PG_RESTORE_FAIL=1
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore rejects every missing variable and executable before mutation" {
  variables='BACKUP_PGHOST BACKUP_PGPORT BACKUP_PGDATABASE BACKUP_SOURCE_ENDPOINT BACKUP_SOURCE_BUCKET RESTORE_ARCHIVE_ENDPOINT RESTORE_ARCHIVE_ACCESS_KEY_ID RESTORE_ARCHIVE_SECRET_ACCESS_KEY RESTORE_ARCHIVE_BUCKET RESTORE_ARCHIVE_PREFIX RESTORE_ARCHIVE_REGION RESTORE_ARCHIVE_FORCE_PATH_STYLE RESTORE_SNAPSHOT_ID RESTORE_TARGET_ENVIRONMENT RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT RESTORE_SOURCE_PROJECT_REF RESTORE_TARGET_PROJECT_REF RESTORE_PGHOST RESTORE_PGPORT RESTORE_PGDATABASE RESTORE_PGUSER RESTORE_PGPASSWORD RESTORE_PGSSLMODE RESTORE_PGSSLROOTCERT_BASE64 RESTORE_TARGET_ENDPOINT RESTORE_TARGET_ACCESS_KEY_ID RESTORE_TARGET_SECRET_ACCESS_KEY RESTORE_TARGET_BUCKET RESTORE_TARGET_REGION RESTORE_TARGET_FORCE_PATH_STYLE'
  for variable in $variables; do
    value=${!variable}; unset "$variable"
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
    export "$variable=$value"
  done
  original_path=$PATH
  for tool in node rclone psql pg_restore date mktemp chmod rm mkdir cmp tr; do
    PATH=$(path_without_tool "$tool"); export PATH
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
    PATH=$original_path; export PATH
  done
  assert_no_external_mutation
}

@test "restore rejects root production-equivalent DB and source or archive Storage targets" {
  for database in template0 template1; do
    valid_restore_env; export RESTORE_PGDATABASE="$database"
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
  done
  valid_restore_env
  export RESTORE_PGHOST="$BACKUP_PGHOST" RESTORE_PGDATABASE="$BACKUP_PGDATABASE"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_PGHOST='DB.INTERNAL.EXAMPLE.' RESTORE_PGPORT="$BACKUP_PGPORT" RESTORE_PGDATABASE="$BACKUP_PGDATABASE"
  : > "$FAKE_LOG"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -s "$FAKE_LOG" ]
  valid_restore_env
  export RESTORE_TARGET_ENDPOINT="$BACKUP_SOURCE_ENDPOINT"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_TARGET_ENDPOINT='https://abcdefghijklmnopqrst.supabase.co/storage/v1/s3'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_ARCHIVE_ENDPOINT='https://abcdefghijklmnopqrst.supabase.co/archive'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_ARCHIVE_ENDPOINT='https://zyxwvutsrqponmlkjihg.supabase.co/archive'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_TARGET_ENDPOINT="$RESTORE_ARCHIVE_ENDPOINT"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_ARCHIVE_ENDPOINT="$BACKUP_SOURCE_ENDPOINT"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_TARGET_ENDPOINT='https://SOURCE.STORAGE.EXAMPLE:443/'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  valid_restore_env
  export RESTORE_TARGET_ENDPOINT="$RESTORE_ARCHIVE_ENDPOINT" RESTORE_TARGET_BUCKET="$RESTORE_ARCHIVE_BUCKET"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  assert_no_external_mutation
}

@test "restore binds Supabase project identities and rejects source or target endpoint aliases before tools" {
  for assignment in \
    'BACKUP_SOURCE_ENDPOINT=https://other.storage.supabase.co/storage/v1/s3' \
    'RESTORE_TARGET_ENDPOINT=https://other.storage.supabase.co/storage/v1/s3' \
    'RESTORE_TARGET_ENDPOINT=https://abcdefghijklmnopqrst.supabase.co/storage/v1/s3' \
    'RESTORE_ARCHIVE_ENDPOINT=https://abcdefghijklmnopqrst.supabase.co/archive' \
    'RESTORE_ARCHIVE_ENDPOINT=https://zyxwvutsrqponmlkjihg.supabase.co/archive' \
    'RESTORE_ARCHIVE_ENDPOINT=https://uvwxyzabcdefghijklmn.storage.supabase.co/storage/v1/s3'; do
    valid_restore_env
    : > "$FAKE_LOG"
    export "${assignment?}"
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
    [ ! -s "$FAKE_LOG" ]
  done
}

@test "restore binds the target database host and Supavisor routing user to its project before tools" {
  for assignment in \
    'RESTORE_PGHOST=db.abcdefghijklmnopqrst.supabase.co' \
    'RESTORE_PGHOST=db.uvwxyzabcdefghijklmn.supabase.co' \
    'RESTORE_PGUSER=postgres.abcdefghijklmnopqrst' \
    'RESTORE_PGDATABASE=other_database'; do
    valid_restore_env
    : > "$FAKE_LOG"
    export "${assignment?}"
    run "$RESTORE_SCRIPT"
    [ "$status" -ne 0 ]
    [ ! -s "$FAKE_LOG" ]
  done

  valid_restore_env
  export RESTORE_PGHOST='aws-0-us-east-1.pooler.supabase.com'
  export RESTORE_PGPORT=5432
  export RESTORE_PGUSER="postgres.$RESTORE_TARGET_PROJECT_REF"
  make_snapshot
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  rm -f "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
}

@test "restore permits a fresh guarded Supabase postgres database target" {
  make_snapshot
  export RESTORE_PGDATABASE='postgres'
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'smoking_zen_restore_target_empty' "$FAKE_LOG")" -eq 2 ]
  grep -q 'smoking_zen_restore_drill_guard' "$FAKE_LOG"
  rm -f "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
}

@test "restore validates nonempty backup and post-copy hashes before evidence" {
  make_snapshot
  base="$FAKE_REMOTE_ROOT/$RESTORE_ARCHIVE_BUCKET/$RESTORE_ARCHIVE_PREFIX/$RESTORE_SNAPSHOT_ID"
  object='11111111-1111-4111-8111-111111111111'
  printf 'restored bytes' > "$base/storage/$object"
  bytes=$(wc -c < "$base/storage/$object" | tr -d ' ')
  sha=$(shasum -a 256 "$base/storage/$object" | awk '{print $1}')
  printf '{"schemaVersion":1,"capturedAt":"2026-08-10T01:02:03.000Z","count":1,"bytes":%s,"files":[{"path":"%s","size":%s,"sha256":"%s"}]}\n' "$bytes" "$object" "$bytes" "$sha" > "$base/storage-checksums.json"
  checksum_sha=$(shasum -a 256 "$base/storage-checksums.json" | awk '{print $1}')
  node -e 'const fs=require("fs"),p=process.argv[1],s=process.argv[2];const m=JSON.parse(fs.readFileSync(p));m.storage={count:1,bytes:14,checksumFileSha256:s};fs.writeFileSync(p,JSON.stringify(m)+"\n")' "$base/manifest.json" "$checksum_sha"
  FAKE_READY_METADATA=$(printf '[{"path":"%s","size":%s,"sha256":"%s"}]' "$object" "$bytes" "$sha")
  export FAKE_READY_METADATA
  run "$RESTORE_SCRIPT"
  [ "$status" -eq 0 ]
  restored="$FAKE_REMOTE_ROOT/$RESTORE_TARGET_BUCKET/$object"
  cmp "$base/storage/$object" "$restored"
  rm -f "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json"
}

@test "restore mutation failure occurs after preverification and leaves no Storage or evidence" {
  make_snapshot
  export FAKE_PG_RESTORE_FAIL=1
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  grep -q '^pg_restore .*<--list>' "$FAKE_LOG"
  grep -q '^pg_restore .*<--clean>' "$FAKE_LOG"
  run grep -q '^rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore measures RTO from before remote and database preflight" {
  make_snapshot
  export FAKE_DATE_SEQUENCE_FILE="$TEST_ROOT/dates"
  printf '20260810T010203Z\n20260810T050204Z\n' > "$FAKE_DATE_SEQUENCE_FILE"
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore rejects an old snapshot on RPO before destructive mutation" {
  make_snapshot
  export FAKE_DATE_OUTPUT='20260812T020304Z'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -Eq '^pg_restore .*--clean|rclone <copy> .*<restore-target:' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore rejects a missing ready attachment after restore and writes no evidence" {
  make_snapshot
  export FAKE_READY_METADATA='[{"path":"11111111-1111-4111-8111-111111111111","size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore rejects business-row count mismatch with no success evidence" {
  make_snapshot
  export FAKE_CORE_ROW_COUNTS='{"appUsers":1,"workspaces":1,"memberships":1,"tasks":1,"knowledgeItems":1,"contacts":1,"attachments":0}'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore rejects ready attachment metadata drift with no success evidence" {
  make_snapshot
  base="$FAKE_REMOTE_ROOT/$RESTORE_ARCHIVE_BUCKET/$RESTORE_ARCHIVE_PREFIX/$RESTORE_SNAPSHOT_ID"
  object='11111111-1111-4111-8111-111111111111'
  printf 'restored bytes' > "$base/storage/$object"
  bytes=$(wc -c < "$base/storage/$object" | tr -d ' ')
  sha=$(shasum -a 256 "$base/storage/$object" | awk '{print $1}')
  printf '{"schemaVersion":1,"capturedAt":"2026-08-10T01:02:03.000Z","count":1,"bytes":%s,"files":[{"path":"%s","size":%s,"sha256":"%s"}]}\n' "$bytes" "$object" "$bytes" "$sha" > "$base/storage-checksums.json"
  checksum_sha=$(shasum -a 256 "$base/storage-checksums.json" | awk '{print $1}')
  node -e 'const fs=require("fs"),p=process.argv[1],s=process.argv[2],b=Number(process.argv[3]);const m=JSON.parse(fs.readFileSync(p));m.storage={count:1,bytes:b,checksumFileSha256:s};fs.writeFileSync(p,JSON.stringify(m)+"\n")' "$base/manifest.json" "$checksum_sha" "$bytes"
  export FAKE_READY_METADATA='[{"path":"11111111-1111-4111-8111-111111111111","size":14,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
}

@test "restore makes post-restore psql validation errors fatal with no evidence" {
  make_snapshot
  export FAKE_SQL_ERROR_MATCH='smoking_zen_ready_attachment_metadata'
  run "$RESTORE_SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$(project_root)/backups/restore-drill-$RESTORE_SNAPSHOT_ID.json" ]
  bad_psql_lines=$(grep '^psql ' "$FAKE_LOG" | grep -v 'ON_ERROR_STOP=1' || true)
  [ -z "$bad_psql_lines" ]
}
