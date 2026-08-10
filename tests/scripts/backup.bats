#!/usr/bin/env bats
# shellcheck disable=SC2016,SC2030,SC2031,SC2153

load test_helper

setup() {
  setup_fake_tools
  BACKUP_SCRIPT="$(project_root)/scripts/backup.sh"
  HELPER="$(project_root)/scripts/backup-metadata.mjs"
  valid_backup_env
}

@test "backup and restore row baselines use the canonical workspace_members table" {
  grep -q 'public.workspace_members)' "$BACKUP_SCRIPT"
  grep -q 'public.workspace_members)' "$(project_root)/scripts/restore-drill.sh"
  run grep -R -q 'public.workspace_memberships' "$(project_root)/scripts"
  [ "$status" -ne 0 ]
}

@test "backup rejects each missing required variable before mutation" {
  for variable in BACKUP_PGHOST BACKUP_PGPORT BACKUP_PGDATABASE BACKUP_PGUSER BACKUP_PGPASSWORD BACKUP_PGSSLMODE BACKUP_PGSSLROOTCERT_BASE64 BACKUP_SOURCE_ENDPOINT BACKUP_SOURCE_PROJECT_REF BACKUP_SOURCE_REGION BACKUP_SOURCE_AUTH_ANON_KEY BACKUP_SOURCE_SESSION_TOKEN BACKUP_SOURCE_BUCKET BACKUP_TARGET_ENDPOINT BACKUP_TARGET_ACCESS_KEY_ID BACKUP_TARGET_SECRET_ACCESS_KEY BACKUP_TARGET_BUCKET BACKUP_TARGET_PREFIX BACKUP_TARGET_ENCRYPTION BACKUP_TARGET_REGION BACKUP_TARGET_FORCE_PATH_STYLE; do
    value=${!variable}; unset "$variable"
    run "$BACKUP_SCRIPT"
    [ "$status" -ne 0 ]
    export "$variable=$value"
  done
  assert_no_external_mutation
}

@test "backup requires verify-full, a private valid CA, and a bounded privileged role" {
  for assignment in \
    'BACKUP_PGSSLMODE=require' \
    'BACKUP_PGSSLROOTCERT_BASE64=not-base64' \
    'BACKUP_PGSSLROOTCERT_BASE64=YWJj'; do
    valid_backup_env; export "${assignment?}"
    run "$BACKUP_SCRIPT"
    [ "$status" -ne 0 ]
  done
  assert_no_external_mutation

  valid_backup_env
  export FAKE_BACKUP_ROLE_GUARD=f
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q 'pg_dump .*<--format=custom>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup supports Supavisor session mode with project-bound routing identity" {
  export BACKUP_PGHOST='aws-0-us-east-1.pooler.supabase.com'
  export BACKUP_PGPORT=5432
  export BACKUP_PGUSER="smoking_zen_backup_reader.$BACKUP_SOURCE_PROJECT_REF"
  export BACKUP_DRY_RUN=1
  run "$BACKUP_SCRIPT"
  [ "$status" -eq 0 ]

  valid_backup_env
  export BACKUP_PGHOST='aws-0-us-east-1.pooler.supabase.com'
  export BACKUP_PGUSER='smoking_zen_backup_reader.wrongprojectref0000'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]

  valid_backup_env
  export BACKUP_PGHOST='db.uvwxyzabcdefghijklmn.supabase.co'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]

  valid_backup_env
  export BACKUP_PGDATABASE='other_database'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
}

@test "backup rejects unsafe endpoint bucket prefix and same source target" {
  for assignment in \
    'BACKUP_TARGET_ENDPOINT=http://backup.example' \
    'BACKUP_TARGET_ENDPOINT=https://user:pass@backup.example' \
    'BACKUP_TARGET_ENDPOINT=https://backup.example:65536' \
    'BACKUP_TARGET_ENDPOINT=https://backup.example/storage/../live' \
    'BACKUP_TARGET_ENDPOINT=https://backup.example/storage/%2f/live' \
    'BACKUP_TARGET_ENDPOINT=https://backup.example/storage?secret=x' \
    'BACKUP_TARGET_ENDPOINT=https://backup.example/storage#fragment' \
    'BACKUP_TARGET_ENDPOINT=https://uvwxyzabcdefghijklmn.storage.supabase.co/storage/v1/s3' \
    'BACKUP_TARGET_BUCKET=Bad/Bucket' \
    'BACKUP_TARGET_PREFIX=one' \
    'BACKUP_TARGET_PREFIX=/one/two' \
    'BACKUP_TARGET_PREFIX=one/../two' \
    'BACKUP_TARGET_PREFIX=one/*'; do
    valid_backup_env; export "${assignment?}"
    run "$BACKUP_SCRIPT"
    [ "$status" -ne 0 ]
  done
  valid_backup_env
  export BACKUP_TARGET_ENDPOINT="$BACKUP_SOURCE_ENDPOINT"
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  valid_backup_env
  export BACKUP_TARGET_ENDPOINT="$BACKUP_SOURCE_ENDPOINT" BACKUP_TARGET_BUCKET="$BACKUP_SOURCE_BUCKET"
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  valid_backup_env
  export BACKUP_TARGET_ENDPOINT='https://ABCDEFGHIJKLMNOPQRST.storage.supabase.co:443/storage/v1/s3/' BACKUP_TARGET_BUCKET="$BACKUP_SOURCE_BUCKET"
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  valid_backup_env
  export BACKUP_TARGET_ENDPOINT='https://abcdefghijklmnopqrst.supabase.co/storage/v1/s3' BACKUP_TARGET_BUCKET='independent-name'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  valid_backup_env
  export BACKUP_TARGET_ENCRYPTION='aws:kms'
  unset BACKUP_TARGET_KMS_KEY_ID
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  assert_no_external_mutation
}

@test "backup rejects libpq conninfo and URI identity overrides before any tool call" {
  for assignment in \
    'BACKUP_PGDATABASE=host=evil dbname=other password=DB_SECRET_SENTINEL' \
    'BACKUP_PGDATABASE=postgresql://user:DB_SECRET_SENTINEL@evil/other' \
    'BACKUP_PGUSER=user options=-c role=evil' \
    'BACKUP_PGHOST=host=evil'; do
    valid_backup_env; export "${assignment?}"
    run "$BACKUP_SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output$(cat "$FAKE_LOG")" != *DB_SECRET_SENTINEL* ]]
  done
  [ ! -s "$FAKE_LOG" ]
}

@test "backup dry run performs read-only preflight and no dump copy upload delete" {
  export FAKE_ASSERT_SOURCE_SESSION=1
  export BACKUP_DRY_RUN=1
  run "$BACKUP_SCRIPT"
  [ "$status" -eq 0 ]
  grep -q '^psql ' "$FAKE_LOG"
  grep -q '^rclone <lsf> <source:workspace-files>' "$FAKE_LOG"
  grep -q '^rclone <lsf>' "$FAKE_LOG"
  assert_no_external_mutation
}

@test "backup rejects a pg_dump or pg_restore major that differs from the source server before mutation" {
  export FAKE_SERVER_VERSION_NUM=170010
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q 'pg_dump .*<--format=custom>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  run grep -Eq '^rclone <(copy|copyto|purge|delete)' "$FAKE_LOG"
  [ "$status" -ne 0 ]

  valid_backup_env
  : > "$FAKE_LOG"
  export FAKE_PG_RESTORE_VERSION=17.10
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q 'pg_dump .*<--format=custom>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup accepts canonical Supabase S3 base paths and preserves them for rclone" {
  export BACKUP_SOURCE_ENDPOINT='https://ABCDEFGHIJKLMNOPQRST.storage.supabase.co:443/storage/v1/s3/'
  export BACKUP_TARGET_ENDPOINT='https://archive.example/backups/s3'
  export BACKUP_DRY_RUN=1
  run "$BACKUP_SCRIPT"
  [ "$status" -eq 0 ]
}

@test "backup happy path uses exact PG flags private escaped passfile and manifest last" {
  export FAKE_ASSERT_PG_CA=1
  run "$BACKUP_SCRIPT"
  [ "$status" -eq 0 ]
  grep -q 'pg_dump .*<--format=custom>.*<--no-owner>.*<--no-privileges>.*<--no-password>.*<--file=' "$FAKE_LOG"
  [ "$(cat "${FAKE_CAPTURE_PGPASS}.mode")" = 600 ]
  [ ! -e "$(cat "$FAKE_CAPTURE_PGSSLROOTCERT")" ]
  grep -Fq 'db.abcdefghijklmnopqrst.supabase.co:5432:postgres:smoking_zen_backup_reader:pw\:with\\slashes-SECRET_SENTINEL' "$FAKE_CAPTURE_PGPASS"
  last_copy=$(grep '^rclone <copyto>' "$FAKE_LOG" | tail -1)
  [[ "$last_copy" == *'/manifest.json>'* ]]
  combined="$output$(cat "$FAKE_LOG")"
  [[ "$combined" != *SOURCE_SECRET_SENTINEL* ]]
  [[ "$combined" != *SOURCE_ANON_SECRET_SENTINEL* ]]
  [[ "$combined" != *SOURCE_SESSION_SECRET_SENTINEL* ]]
  [[ "$combined" != *TARGET_SECRET_SENTINEL* ]]
  [[ "$combined" != *pw:with* ]]
  manifest="$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX/20260810T010203Z/manifest.json"
  grep -q '"schemaVersion":2' "$manifest"
  grep -q '"serverMajor":18' "$manifest"
  grep -q '"serverVersionNum":180004' "$manifest"
  grep -q '"clientMajor":18' "$manifest"
  grep -q '"clientVersion":"18.4"' "$manifest"
  grep -q '"sourceProjectRef":"abcdefghijklmnopqrst"' "$manifest"
  grep -q '"schemaRevision":"0019"' "$manifest"
}

@test "backup PG failure creates no remote artifacts or retention" {
  export FAKE_PG_DUMP_FAIL=1
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <copyto>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <purge>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup rejects any out-of-scope TOC before uploading an artifact" {
  export FAKE_TOC=$'; archive\n1; 0 0 TABLE auth users postgres\n2; 0 0 TABLE DATA auth users postgres\n'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <copyto>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  grep -q 'pg_dump .*<--schema=public>.*<--schema=private>' "$FAKE_LOG"
}

@test "backup storage failure may leave independent DB artifact but never manifest or retention" {
  export FAKE_RCLONE_FAIL_COMMAND=copy
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  grep -q '/database.dump>' "$FAKE_LOG"
  run grep -q '/manifest.json>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <purge>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup never completes when its database snapshot references a missing ready object" {
  export FAKE_READY_METADATA='[{"path":"11111111-1111-4111-8111-111111111111","size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'
  export FAKE_SOURCE_JSON='[]'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '/manifest.json>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <purge>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup makes psql SQL failures fatal before manifest publication" {
  export FAKE_SQL_ERROR_MATCH='set transaction snapshot'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '/manifest.json>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  bad_psql_lines=$(grep '^psql ' "$FAKE_LOG" | grep -v 'ON_ERROR_STOP=1' || true)
  [ -z "$bad_psql_lines" ]
}

@test "backup rejects zero business-row baselines before manifest publication" {
  export FAKE_CORE_ROW_COUNTS='{"appUsers":0,"workspaces":0,"memberships":0,"tasks":0,"knowledgeItems":0,"contacts":0,"attachments":0}'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '/manifest.json>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup rejects ready object size or hash drift from its database snapshot" {
  object='11111111-1111-4111-8111-111111111111'
  printf 'private object bytes' > "$FAKE_OBJECT_ROOT/$object"
  export FAKE_SOURCE_JSON='[{"Path":"11111111-1111-4111-8111-111111111111","Size":20}]'
  export FAKE_READY_METADATA='[{"path":"11111111-1111-4111-8111-111111111111","size":20,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '/manifest.json>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  export FAKE_READY_METADATA='[{"path":"11111111-1111-4111-8111-111111111111","size":19,"sha256":"d127c39903ba736a8a2283784a1f26ef21e9a6c0bca723b81d39a4532ba8ae2a"}]'
  : > "$FAKE_LOG"
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '/manifest.json>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup accepts empty Storage and rejects an existing snapshot collision" {
  export FAKE_SOURCE_JSON='[]'
  run "$BACKUP_SCRIPT"
  [ "$status" -eq 0 ]
  export FAKE_TARGET_DIRS=$'20260810T010203Z/\n'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
}

@test "backup fails closed before mutation when retention sees a complete foreign-source manifest" {
  foreign=20260701T010203Z
  base="$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX/$foreign"
  mkdir -p "$base"
  instant=2026-07-01T01:02:03.000Z
  printf '{"schemaVersion":2,"snapshotId":"%s","sourceProjectRef":"zyxwvutsrqponmlkjihg","schemaRevision":"0019","startedAt":"%s","oldestCaptureAt":"%s","completedAt":"%s","database":{"bytes":1,"sha256":"%064d","tocEntries":1,"serverMajor":18,"serverVersionNum":180004,"clientMajor":18,"clientVersion":"18.4","rowCounts":{"appUsers":1,"workspaces":1,"memberships":1,"tasks":0,"knowledgeItems":0,"contacts":0,"attachments":0}},"storage":{"count":0,"bytes":0,"checksumFileSha256":"%064d"}}\n' \
    "$foreign" "$instant" "$instant" "$instant" 0 0 > "$base/manifest.json"
  export FAKE_TARGET_DIRS="$foreign/"$'\n'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  assert_no_external_mutation
}

@test "backup retention rejects a complete legacy schema-v1 marker before mutation" {
  legacy=20260601T010203Z
  base="$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX/$legacy"
  mkdir -p "$base"
  printf '{"schemaVersion":1,"snapshotId":"%s","startedAt":"2026-06-01T01:02:03.000Z","oldestCaptureAt":"2026-06-01T01:02:03.000Z","completedAt":"2026-06-01T01:02:03.000Z","database":{"bytes":1,"sha256":"%064d","tocEntries":1,"rowCounts":{"appUsers":1,"workspaces":1,"memberships":1,"tasks":0,"knowledgeItems":0,"contacts":0,"attachments":0}},"storage":{"count":0,"bytes":0,"checksumFileSha256":"%064d"}}\n' \
    "$legacy" 0 0 > "$base/manifest.json"
  export FAKE_TARGET_DIRS="$legacy/"$'\n'
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  assert_no_external_mutation
}

@test "metadata helper computes ISO retention union and strict freshness" {
  directory="$TEST_ROOT/exact-retention"
  node -e '
    const fs=require("fs"),path=require("path"),root=process.argv[1];fs.mkdirSync(root,{recursive:true});
    const ids=["20260103T120000Z","20260103T060000Z","20260102T120000Z","20251231T230000Z","20251230T120000Z","20251228T120000Z","20251222T120000Z","20251215T120000Z","20251208T120000Z","20251130T120000Z","20251031T120000Z","20250930T120000Z","20250831T120000Z","20250731T120000Z","20250630T120000Z","20250531T120000Z","20250430T120000Z","20250331T120000Z","20250228T120000Z","20250131T120000Z","20241231T120000Z","20241130T120000Z","20241031T120000Z","20240930T120000Z"];
    const rows={appUsers:1,workspaces:1,memberships:1,tasks:0,knowledgeItems:0,contacts:0,attachments:0};
    for(const id of ids){const iso=`${id.slice(0,4)}-${id.slice(4,6)}-${id.slice(6,8)}T${id.slice(9,11)}:${id.slice(11,13)}:${id.slice(13,15)}.000Z`;fs.writeFileSync(path.join(root,`${id}.json`),JSON.stringify({schemaVersion:2,snapshotId:id,sourceProjectRef:"abcdefghijklmnopqrst",schemaRevision:"0019",startedAt:iso,oldestCaptureAt:iso,completedAt:iso,database:{bytes:1,sha256:"a".repeat(64),tocEntries:1,serverMajor:18,serverVersionNum:180004,clientMajor:18,clientVersion:"18.4",rowCounts:rows},storage:{count:0,bytes:0,checksumFileSha256:"b".repeat(64)}}));}
    fs.writeFileSync(path.join(root,"20240201T000000Z.json"),"{}");
    fs.writeFileSync(path.join(root,"not-a-snapshot.json"),"{}");
  ' "$directory"
  run node "$HELPER" retention --directory "$directory" --now '2026-01-03T12:00:00.000Z' --source-project-ref abcdefghijklmnopqrst
  [ "$status" -eq 0 ]
  expected='{"keep":["20260103T120000Z","20260103T060000Z","20260102T120000Z","20251231T230000Z","20251230T120000Z","20251228T120000Z","20251222T120000Z","20251215T120000Z","20251208T120000Z","20251130T120000Z","20251031T120000Z","20250930T120000Z","20250831T120000Z","20250731T120000Z","20250630T120000Z","20250531T120000Z","20250430T120000Z","20250331T120000Z","20250228T120000Z"],"delete":["20240930T120000Z","20241031T120000Z","20241130T120000Z","20241231T120000Z","20250131T120000Z"]}'
  [ "$output" = "$expected" ]
  first_manifest="$directory/20260103T120000Z.json"
  run node "$HELPER" freshness --manifest "$first_manifest" --now '2026-01-04T14:00:00.000Z' --source-project-ref abcdefghijklmnopqrst
  [ "$status" -eq 0 ]
  run node "$HELPER" freshness --manifest "$first_manifest" --now '2026-01-04T14:00:00.001Z' --source-project-ref abcdefghijklmnopqrst
  [ "$status" -ne 0 ]
}

@test "backup retention deletion failure is nonzero and never targets malformed roots" {
  export FAKE_PURGE_FAIL=1
  list="$TEST_ROOT/dirs"
  node -e '
    const fs=require("fs"), path=require("path");
    const root=process.argv[1], list=[];
    for(let i=1;i<=16;i++){
      const d=new Date(Date.UTC(2026,7-i,1,0,0,0));
      const id=d.toISOString().replace(/[-:]/g,"").replace(/\.000/,"");
      const dir=path.join(root,id); fs.mkdirSync(dir,{recursive:true});
      const t=d.toISOString();
      fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify({schemaVersion:2,snapshotId:id,sourceProjectRef:"abcdefghijklmnopqrst",schemaRevision:"0019",startedAt:t,oldestCaptureAt:t,completedAt:t,database:{bytes:1,sha256:"a".repeat(64),tocEntries:1,serverMajor:18,serverVersionNum:180004,clientMajor:18,clientVersion:"18.4",rowCounts:{appUsers:1,workspaces:1,memberships:1,tasks:0,knowledgeItems:0,contacts:0,attachments:0}},storage:{count:0,bytes:0,checksumFileSha256:"b".repeat(64)}}));
      list.push(`${id}/`);
    }
    fs.writeFileSync(process.argv[2],`${list.join("\n")}\nnot-a-snapshot/\n20240101T000000Z/child/\n`);
  ' "$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX" "$list"
  FAKE_TARGET_DIRS=$(cat "$list")
  export FAKE_TARGET_DIRS
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q 'not-a-snapshot' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  run grep -q 'child' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "backup rejects each missing executable before remote mutation" {
  original_path=$PATH
  for tool in node rclone psql pg_dump pg_restore date mktemp chmod rm cp cmp mkdir mkfifo; do
    PATH=$(path_without_tool "$tool")
    export PATH
    run "$BACKUP_SCRIPT"
    [ "$status" -ne 0 ]
    PATH=$original_path
    export PATH
  done
  assert_no_external_mutation
}

@test "backup removes the private passfile and validates a nonempty uploaded Storage snapshot" {
  object='11111111-1111-4111-8111-111111111111'
  printf 'private object bytes' > "$FAKE_OBJECT_ROOT/$object"
  export FAKE_SOURCE_JSON='[{"Path":"11111111-1111-4111-8111-111111111111","Size":20}]'
  run "$BACKUP_SCRIPT"
  [ "$status" -eq 0 ]
  pgpass_path=$(cat "${FAKE_CAPTURE_PGPASS}.path")
  [ ! -e "$pgpass_path" ]
  snapshot="$FAKE_REMOTE_ROOT/$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX/20260810T010203Z"
  cmp "$FAKE_OBJECT_ROOT/$object" "$snapshot/storage/$object"
  manifest=$(cat "$snapshot/manifest.json")
  [[ "$manifest" == *'"count":1'* ]]
  [[ "$manifest" == *'"bytes":20'* ]]
}

@test "backup scrubs inherited libpq routing and session variables" {
  export FAKE_ASSERT_PG_SCRUB=1
  export PGHOSTADDR='PG_SECRET_SENTINEL' PGOPTIONS='-c malicious=true' \
    PGSERVICE='attacker' PGSERVICEFILE='/attacker' PGPASSWORD='PG_SECRET_SENTINEL'
  run "$BACKUP_SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output$(cat "$FAKE_LOG")" != *PG_SECRET_SENTINEL* ]]
}

@test "backup never publishes a manifest or applies retention when checksum or manifest upload fails" {
  for match in storage-checksums.json manifest.json; do
    : > "$FAKE_LOG"
    rm -rf "${FAKE_REMOTE_ROOT:?}/${BACKUP_TARGET_BUCKET:?}"
    export FAKE_RCLONE_FAIL_MATCH="$match"
    run "$BACKUP_SCRIPT"
    [ "$status" -ne 0 ]
    run grep -q '^rclone <purge>' "$FAKE_LOG"
    [ "$status" -ne 0 ]
    if [[ "$match" == storage-checksums.json ]]; then
      run grep -q '/manifest.json>' "$FAKE_LOG"
      [ "$status" -ne 0 ]
    fi
  done
}

@test "backup rejects stale capture before manifest publication or retention" {
  export FAKE_DATE_SEQUENCE_FILE="$TEST_ROOT/dates"
  printf '20260810T010203Z\n20260810T010203Z\n20260810T010203Z\n20260811T040204Z\n' > "$FAKE_DATE_SEQUENCE_FILE"
  run "$BACKUP_SCRIPT"
  [ "$status" -ne 0 ]
  run grep -q '/manifest.json>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
  run grep -q '^rclone <purge>' "$FAKE_LOG"
  [ "$status" -ne 0 ]
}

@test "metadata helper requires retention manifests to match filenames and refuses failed RPO evidence" {
  directory="$TEST_ROOT/retention"
  mkdir -p "$directory"
  input="$directory/20260101T000000Z.json"
  printf '{"schemaVersion":2,"snapshotId":"20260201T000000Z","sourceProjectRef":"abcdefghijklmnopqrst","schemaRevision":"0019","startedAt":"2026-02-01T00:00:00.000Z","oldestCaptureAt":"2026-02-01T00:00:00.000Z","completedAt":"2026-02-01T00:00:00.000Z","database":{"bytes":1,"sha256":"%064d","tocEntries":1,"serverMajor":18,"serverVersionNum":180004,"clientMajor":18,"clientVersion":"18.4","rowCounts":{"appUsers":1,"workspaces":1,"memberships":1,"tasks":0,"knowledgeItems":0,"contacts":0,"attachments":0}},"storage":{"count":0,"bytes":0,"checksumFileSha256":"%064d"}}\n' 0 0 > "$input"
  run node "$HELPER" retention --directory "$directory" --now '2026-02-02T00:00:00.000Z' --source-project-ref abcdefghijklmnopqrst
  [ "$status" -eq 0 ]
  [ "$output" = '{"keep":[],"delete":[]}' ]
  manifest="$TEST_ROOT/old-manifest.json"
  sed 's/2026-02-01T00:00:00.000Z/2026-01-01T00:00:00.000Z/g' "$input" > "$manifest"
  rows="$TEST_ROOT/rows.json"; printf '{"aggregateRows":3,"rowCountsVerified":true}\n' > "$rows"
  run node "$HELPER" evidence --manifest "$manifest" --started-at '2026-02-02T00:00:00.000Z' --completed-at '2026-02-02T00:01:00.000Z' --rows "$rows" --output "$TEST_ROOT/evidence.json"
  [ "$status" -ne 0 ]
  [ ! -e "$TEST_ROOT/evidence.json" ]
}

@test "retention fails closed on a future completed snapshot and never proposes legitimate deletion" {
  input="$TEST_ROOT/future-retention.json"
  node -e '
    const fs=require("fs"), values=[];
    for(let hour=0;hour<8;hour++){
      const d=new Date(Date.UTC(2026,7,10,hour));
      const id=d.toISOString().replace(/[-:]/g,"").replace(/\.000/,"");
      values.push({schemaVersion:2,snapshotId:id,sourceProjectRef:"abcdefghijklmnopqrst",schemaRevision:"0019",startedAt:d.toISOString(),oldestCaptureAt:d.toISOString(),completedAt:d.toISOString(),database:{bytes:1,sha256:"a".repeat(64),tocEntries:1,serverMajor:18,serverVersionNum:180004,clientMajor:18,clientVersion:"18.4",rowCounts:{appUsers:1,workspaces:1,memberships:1,tasks:0,knowledgeItems:0,contacts:0,attachments:0}},storage:{count:0,bytes:0,checksumFileSha256:"b".repeat(64)}});
    }
    const d=new Date("2030-01-01T00:00:00.000Z");
    values.push({schemaVersion:2,snapshotId:"20300101T000000Z",sourceProjectRef:"abcdefghijklmnopqrst",schemaRevision:"0019",startedAt:d.toISOString(),oldestCaptureAt:d.toISOString(),completedAt:d.toISOString(),database:{bytes:1,sha256:"a".repeat(64),tocEntries:1,serverMajor:18,serverVersionNum:180004,clientMajor:18,clientVersion:"18.4",rowCounts:{appUsers:1,workspaces:1,memberships:1,tasks:0,knowledgeItems:0,contacts:0,attachments:0}},storage:{count:0,bytes:0,checksumFileSha256:"b".repeat(64)}});
    fs.writeFileSync(process.argv[1],JSON.stringify(values));
  ' "$input"
  run node "$HELPER" retention --input "$input" --now '2026-08-10T08:00:00.000Z' --source-project-ref abcdefghijklmnopqrst
  [ "$status" -ne 0 ]
  [[ "$output" != *'"delete"'* ]]
}
