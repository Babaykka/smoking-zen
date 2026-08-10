# shellcheck disable=SC2016

project_root() {
  cd "$BATS_TEST_DIRNAME/../.." && pwd
}

setup_fake_tools() {
  export TEST_ROOT="$BATS_TEST_TMPDIR/runtime"
  export FAKE_BIN="$TEST_ROOT/bin"
  export FAKE_REMOTE_ROOT="$TEST_ROOT/remote"
  export FAKE_OBJECT_ROOT="$TEST_ROOT/objects"
  export FAKE_LOG="$TEST_ROOT/calls.log"
  export FAKE_CAPTURE_PGPASS="$TEST_ROOT/pgpass.capture"
  export FAKE_CAPTURE_PGSSLROOTCERT="$TEST_ROOT/pgsslrootcert.path"
  mkdir -p "$FAKE_BIN" "$FAKE_REMOTE_ROOT" "$FAKE_OBJECT_ROOT"
  : > "$FAKE_LOG"

  printf '%s\n' '#!/usr/bin/env bash' \
    'set -Eeuo pipefail' \
    'name=${0##*/}' \
    'printf "%s" "$name" >> "$FAKE_LOG"' \
    'for arg in "$@"; do printf " <%s>" "$arg" >> "$FAKE_LOG"; done' \
    'printf "\n" >> "$FAKE_LOG"' \
    'if [[ ${FAKE_ASSERT_PG_SCRUB:-0} == 1 && $name == pg* || ${FAKE_ASSERT_PG_SCRUB:-0} == 1 && $name == psql ]]; then' \
    '  [[ -z ${PGHOSTADDR:-}${PGOPTIONS:-}${PGSERVICE:-}${PGSERVICEFILE:-}${PGPASSWORD:-} ]] || exit 19' \
    'fi' \
    'if [[ ${FAKE_ASSERT_PG_CA:-0} == 1 && $name == pg* || ${FAKE_ASSERT_PG_CA:-0} == 1 && $name == psql ]]; then' \
    '  [[ -f ${PGSSLROOTCERT:-} ]] || exit 21' \
    '  mode=$(stat -f "%Lp" "$PGSSLROOTCERT" 2>/dev/null || stat -c "%a" "$PGSSLROOTCERT")' \
    '  [[ $mode == 600 ]] || exit 21; printf "%s\n" "$PGSSLROOTCERT" > "$FAKE_CAPTURE_PGSSLROOTCERT"' \
    'fi' \
    'if [[ ${FAKE_ASSERT_SOURCE_SESSION:-0} == 1 && $name == rclone ]]; then' \
    '  [[ ${RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID:-} == abcdefghijklmnopqrst ]] || exit 20' \
    '  [[ ${RCLONE_CONFIG_SOURCE_REGION:-} == us-east-1 && ${RCLONE_CONFIG_SOURCE_FORCE_PATH_STYLE:-} == true ]] || exit 20' \
    '  [[ ${RCLONE_CONFIG_SOURCE_SESSION_TOKEN:-} == *SOURCE_SESSION_SECRET_SENTINEL* ]] || exit 20' \
    '  [[ ${RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY:-} == *SOURCE_ANON_SECRET_SENTINEL* ]] || exit 20' \
    'fi' \
    'case "$name" in' \
    '  date)' \
    '    if [[ -n ${FAKE_DATE_SEQUENCE_FILE:-} && -s $FAKE_DATE_SEQUENCE_FILE ]]; then' \
    '      IFS= read -r value < "$FAKE_DATE_SEQUENCE_FILE"; tail -n +2 "$FAKE_DATE_SEQUENCE_FILE" > "$FAKE_DATE_SEQUENCE_FILE.next"; mv "$FAKE_DATE_SEQUENCE_FILE.next" "$FAKE_DATE_SEQUENCE_FILE"; printf "%s\n" "$value"' \
    '    else printf "%s\n" "${FAKE_DATE_OUTPUT:-20260810T010203Z}"; fi ;;' \
    '  psql)' \
    '    [[ ${FAKE_PSQL_FAIL:-0} != 1 ]] || exit 9' \
    '    args=" $* "' \
    '    if [[ -n ${FAKE_SQL_ERROR_MATCH:-} && $args == *"$FAKE_SQL_ERROR_MATCH"* ]]; then [[ $args != *ON_ERROR_STOP=1* ]] || exit 9; printf "simulated SQL error\n" >&2; exit 0; fi' \
    '    if [[ $args != *" --command "* ]]; then printf "%s\n" "${FAKE_DATABASE_SNAPSHOT:-00000003-0000001B-1}"; cat > /dev/null' \
    '    elif [[ $args == *server_version_num* ]]; then printf "%s\n" "${FAKE_SERVER_VERSION_NUM:-180004}"' \
    '    elif [[ $args == *smoking_zen_backup_role_guard* ]]; then printf "%s\n" "${FAKE_BACKUP_ROLE_GUARD:-t}"' \
    '    elif [[ $args == *smoking_zen_ready_attachment_metadata* ]]; then printf "%s\n" "${FAKE_READY_METADATA:-[]}"' \
    '    elif [[ $args == *smoking_zen_core_row_counts* ]]; then printf "%s\n" "${FAKE_CORE_ROW_COUNTS:-{\"appUsers\":1,\"workspaces\":1,\"memberships\":1,\"tasks\":2,\"knowledgeItems\":1,\"contacts\":1,\"attachments\":0}}"' \
    '    elif [[ $args == *smoking_zen_restore_target_empty* ]]; then printf "%s\n" "${FAKE_DB_EMPTY:-t}"' \
    '    elif [[ $args == *smoking_zen_restore_drill_guard* ]]; then printf "%s\n" "${FAKE_GUARD:-t}"' \
    '    elif [[ $args == *smoking_zen_business_digest* ]]; then count=$(grep -c smoking_zen_business_digest "$FAKE_LOG"); if ((count > 1)); then printf "%s\n" "${FAKE_BUSINESS_DIGEST_AFTER:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"; else printf "%s\n" "${FAKE_BUSINESS_DIGEST_BEFORE:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"; fi' \
    '    elif [[ $args == *smoking_zen_restore_acl_guard* ]]; then printf "%s\n" "${FAKE_ACL_GUARD:-t}"' \
    '    elif [[ $args == *storage_path* ]]; then printf "%b" "${FAKE_READY_PATHS:-}"' \
    '    elif [[ $args == *json_build_object* ]]; then printf "%s\n" "${FAKE_ROW_COUNTS:-{\"aggregateRows\":12}}"' \
    '    else printf "1\n"; fi ;;' \
  '  pg_dump)' \
    '    if [[ " $* " == *" --version "* ]]; then printf "pg_dump (PostgreSQL) %s\n" "${FAKE_PG_DUMP_VERSION:-18.4}"; exit 0; fi' \
    '    [[ ${FAKE_PG_DUMP_FAIL:-0} != 1 ]] || exit 8' \
    '    output=""; for arg in "$@"; do case "$arg" in --file=*) output=${arg#--file=};; esac; done' \
    '    [[ -n $output ]] || exit 7' \
    '    printf "fake-custom-dump\n" > "$output"' \
    '    stat -f "%Lp" "$PGPASSFILE" > "${FAKE_CAPTURE_PGPASS}.mode" 2>/dev/null || stat -c "%a" "$PGPASSFILE" > "${FAKE_CAPTURE_PGPASS}.mode"' \
    '    cp "$PGPASSFILE" "$FAKE_CAPTURE_PGPASS"' \
    '    printf "%s\n" "$PGPASSFILE" > "${FAKE_CAPTURE_PGPASS}.path" ;;' \
  '  pg_restore)' \
    '    if [[ " $* " == *" --version "* ]]; then printf "pg_restore (PostgreSQL) %s\n" "${FAKE_PG_RESTORE_VERSION:-18.4}"' \
    '    elif [[ " $* " == *" --list "* ]]; then' \
    '      [[ ${FAKE_PG_RESTORE_LIST_FAIL:-0} != 1 ]] || exit 6' \
    '      printf "%b" "${FAKE_TOC:-; archive\\n1; 0 0 TABLE public tasks postgres\\n2; 0 0 TABLE DATA public tasks postgres\\n}"' \
    '    else [[ ${FAKE_PG_RESTORE_FAIL:-0} != 1 ]] || exit 6; fi ;;' \
    '  rclone)' \
    '    command=${1:-}; shift || true' \
    '    [[ ${FAKE_RCLONE_FAIL_COMMAND:-} != "$command" ]] || exit 5' \
    '    [[ -z ${FAKE_RCLONE_FAIL_MATCH:-} || " $command $* " != *"$FAKE_RCLONE_FAIL_MATCH"* ]] || exit 5' \
    '    case "$command" in' \
    '      lsjson) printf "%s\n" "${FAKE_SOURCE_JSON:-[]}" ;;' \
    '      lsf)' \
    '        remote=${1:-}' \
    '        if [[ $remote == restore-target:* ]]; then' \
    '          if [[ -n ${FAKE_RESTORE_TARGET_LIST+x} ]]; then printf "%b" "$FAKE_RESTORE_TARGET_LIST"' \
    '          else root="$FAKE_REMOTE_ROOT/${remote#*:}"; [[ ! -d $root ]] || (cd "$root" && find . -type f -print | sed "s#^./##" | sort); fi' \
    '        else printf "%b" "${FAKE_TARGET_DIRS:-}"; fi ;;' \
    '      cat)' \
    '        remote=${1#*:}; cat "$FAKE_REMOTE_ROOT/$remote" ;;' \
    '      copy)' \
    '        source=${1:-}; destination=${2:-}; shift 2 || true' \
    '        files=""; while (($#)); do [[ $1 == --files-from-raw ]] && { files=$2; shift 2; continue; }; shift; done' \
    '        if [[ $source == *:* && $destination != *:* ]]; then' \
    '          remote=${source#*:}; root=$FAKE_REMOTE_ROOT; [[ $source == source:* ]] && root=$FAKE_OBJECT_ROOT' \
    '          mkdir -p "$destination"; [[ -z $files ]] || while IFS= read -r path; do [[ -n $path ]] || continue; parent=$destination; [[ $path != */* ]] || parent="$destination/${path%/*}"; mkdir -p "$parent"; cp "$root/$remote/$path" "$destination/$path" 2>/dev/null || cp "$root/$path" "$destination/$path"; done < "$files"' \
    '        elif [[ $source != *:* && $destination == *:* ]]; then' \
    '          remote=${destination#*:}; root="$FAKE_REMOTE_ROOT/$remote"; mkdir -p "$root"' \
    '          [[ -z $files ]] || while IFS= read -r path; do [[ -n $path ]] || continue; parent=$root; [[ $path != */* ]] || parent="$root/${path%/*}"; mkdir -p "$parent"; cp "$source/$path" "$root/$path"; done < "$files"' \
    '        fi ;;' \
    '      copyto)' \
    '        source=${1:-}; destination=${2:-}' \
    '        if [[ $source == *:* ]]; then remote=${source#*:}; mkdir -p "${destination%/*}"; cp "$FAKE_REMOTE_ROOT/$remote" "$destination"' \
    '        else remote=${destination#*:}; mkdir -p "$FAKE_REMOTE_ROOT/${remote%/*}"; cp "$source" "$FAKE_REMOTE_ROOT/$remote"; fi ;;' \
    '      check) : ;;' \
    '      purge) [[ ${FAKE_PURGE_FAIL:-0} != 1 ]] || exit 4 ;;' \
    '      *) exit 3 ;;' \
    '    esac ;;' \
    'esac' > "$FAKE_BIN/fake-tool"
  chmod +x "$FAKE_BIN/fake-tool"
  for tool in date psql pg_dump pg_restore rclone; do ln -s fake-tool "$FAKE_BIN/$tool"; done
  export PATH="$FAKE_BIN:$PATH"
}

valid_backup_env() {
  export BACKUP_PGHOST='db.abcdefghijklmnopqrst.supabase.co'
  export BACKUP_PGPORT='5432'
  export BACKUP_PGDATABASE='postgres'
  export BACKUP_PGUSER='smoking_zen_backup_reader'
  export BACKUP_PGPASSWORD='pw:with\slashes-SECRET_SENTINEL'
  export BACKUP_PGSSLMODE='verify-full'
  export BACKUP_PGSSLROOTCERT_BASE64
  BACKUP_PGSSLROOTCERT_BASE64=$(printf '%s\n' '-----BEGIN CERTIFICATE-----' 'QUJDRA==' '-----END CERTIFICATE-----' | base64 | tr -d '\n')
  export BACKUP_SOURCE_ENDPOINT='https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3'
  export BACKUP_SOURCE_PROJECT_REF='abcdefghijklmnopqrst'
  export BACKUP_SOURCE_REGION='us-east-1'
  export BACKUP_SOURCE_AUTH_ANON_KEY='eyJhbGciOiJIUzI1NiJ9.SOURCE_ANON_SECRET_SENTINEL.signature'
  export BACKUP_SOURCE_SESSION_TOKEN='eyJhbGciOiJIUzI1NiJ9.SOURCE_SESSION_SECRET_SENTINEL.signature'
  export BACKUP_SOURCE_BUCKET='workspace-files'
  export BACKUP_TARGET_ENDPOINT='https://backup.storage.example'
  export BACKUP_TARGET_ACCESS_KEY_ID='TARGET_KEY_SENTINEL'
  export BACKUP_TARGET_SECRET_ACCESS_KEY='TARGET_SECRET_SENTINEL'
  export BACKUP_TARGET_BUCKET='smoking-zen-backups'
  export BACKUP_TARGET_PREFIX='production/daily'
  export BACKUP_TARGET_ENCRYPTION='AES256'
  export BACKUP_TARGET_REGION='us-east-1'
  export BACKUP_TARGET_FORCE_PATH_STYLE='true'
}

valid_restore_env() {
  valid_backup_env
  export RESTORE_ARCHIVE_ENDPOINT="$BACKUP_TARGET_ENDPOINT"
  export RESTORE_ARCHIVE_ACCESS_KEY_ID='RESTORE_ARCHIVE_KEY_SENTINEL'
  export RESTORE_ARCHIVE_SECRET_ACCESS_KEY='RESTORE_ARCHIVE_SECRET_SENTINEL'
  export RESTORE_ARCHIVE_BUCKET="$BACKUP_TARGET_BUCKET"
  export RESTORE_ARCHIVE_PREFIX="$BACKUP_TARGET_PREFIX"
  export RESTORE_ARCHIVE_REGION="$BACKUP_TARGET_REGION"
  export RESTORE_ARCHIVE_FORCE_PATH_STYLE="$BACKUP_TARGET_FORCE_PATH_STYLE"
  export RESTORE_SNAPSHOT_ID='20260810T010203Z'
  export RESTORE_TARGET_ENVIRONMENT='restore-drill'
  export RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT='RESTORE_ISOLATED_TARGET'
  export RESTORE_SOURCE_PROJECT_REF='abcdefghijklmnopqrst'
  export RESTORE_TARGET_PROJECT_REF='zyxwvutsrqponmlkjihg'
  export RESTORE_PGHOST='db.zyxwvutsrqponmlkjihg.supabase.co'
  export RESTORE_PGPORT='5432'
  export RESTORE_PGDATABASE='postgres'
  export RESTORE_PGUSER='postgres'
  export RESTORE_PGPASSWORD='restore:pw\SECRET_SENTINEL'
  export RESTORE_PGSSLMODE='verify-full'
  export RESTORE_PGSSLROOTCERT_BASE64="$BACKUP_PGSSLROOTCERT_BASE64"
  export RESTORE_TARGET_ENDPOINT='https://zyxwvutsrqponmlkjihg.storage.supabase.co/storage/v1/s3'
  export RESTORE_TARGET_ACCESS_KEY_ID='RESTORE_KEY_SENTINEL'
  export RESTORE_TARGET_SECRET_ACCESS_KEY='RESTORE_SECRET_SENTINEL'
  export RESTORE_TARGET_BUCKET='workspace-files'
  export RESTORE_TARGET_REGION='us-east-1'
  export RESTORE_TARGET_FORCE_PATH_STYLE='true'
}

path_without_tool() {
  local omitted=$1 tool resolved
  local isolated="$TEST_ROOT/no-$omitted"
  mkdir -p "$isolated"
  for tool in bash node rclone psql pg_dump pg_restore date mktemp chmod rm cp cmp mkdir mkfifo tr; do
    [[ "$tool" == "$omitted" ]] && continue
    if [[ -e "$FAKE_BIN/$tool" ]]; then
      ln -s "$FAKE_BIN/$tool" "$isolated/$tool"
    else
      resolved=$(command -v "$tool")
      ln -s "$resolved" "$isolated/$tool"
    fi
  done
  printf '%s\n' "$isolated"
}

assert_no_external_mutation() {
  ! grep '^pg_dump ' "$FAKE_LOG" | grep -vq '<--version>'
  ! grep -Eq '^pg_restore .*<--clean>|^rclone <(copy|copyto)> .*<(target|restore-target):|^rclone <(purge|delete)>' "$FAKE_LOG"
}
