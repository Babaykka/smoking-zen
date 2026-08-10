#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077

SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_PARENT=.
[[ "$SCRIPT_PATH" != */* ]] || SCRIPT_PARENT=${SCRIPT_PATH%/*}
SCRIPT_DIR=$(CDPATH='' cd -- "$SCRIPT_PARENT" && pwd)
METADATA_HELPER="$SCRIPT_DIR/backup-metadata.mjs"
SCRATCH=''
DATABASE_SNAPSHOT_PID=''
DATABASE_SNAPSHOT_FD_OPEN=0

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if (( DATABASE_SNAPSHOT_FD_OPEN == 1 )); then
    exec 3>&- || true
    DATABASE_SNAPSHOT_FD_OPEN=0
  fi
  if [[ -n "$DATABASE_SNAPSHOT_PID" ]]; then
    kill "$DATABASE_SNAPSHOT_PID" 2>/dev/null || true
    wait "$DATABASE_SNAPSHOT_PID" 2>/dev/null || true
  fi
  if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
    rm -rf -- "$SCRATCH"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  printf '%s\n' 'Backup operation failed.' >&2
  exit 1
}

require_value() {
  local name=$1
  [[ -n ${!name:-} ]] || die
  [[ ${!name} != *$'\n'* && ${!name} != *$'\r'* ]] || die
}

for variable in \
  BACKUP_PGHOST BACKUP_PGPORT BACKUP_PGDATABASE BACKUP_PGUSER BACKUP_PGPASSWORD BACKUP_PGSSLMODE \
  BACKUP_PGSSLROOTCERT_BASE64 \
  BACKUP_SOURCE_ENDPOINT BACKUP_SOURCE_PROJECT_REF BACKUP_SOURCE_REGION BACKUP_SOURCE_AUTH_ANON_KEY \
  BACKUP_SOURCE_SESSION_TOKEN BACKUP_SOURCE_BUCKET \
  BACKUP_TARGET_ENDPOINT BACKUP_TARGET_ACCESS_KEY_ID BACKUP_TARGET_SECRET_ACCESS_KEY BACKUP_TARGET_BUCKET \
  BACKUP_TARGET_PREFIX BACKUP_TARGET_ENCRYPTION BACKUP_TARGET_REGION BACKUP_TARGET_FORCE_PATH_STYLE; do
  require_value "$variable"
done

for tool in node rclone psql pg_dump pg_restore date mktemp chmod rm cp cmp mkdir mkfifo; do
  command -v "$tool" >/dev/null 2>&1 || die
done
[[ -f "$METADATA_HELPER" ]] || die

valid_bucket() {
  local bucket=$1
  [[ ${#bucket} -ge 3 && ${#bucket} -le 63 ]] || return 1
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || return 1
  [[ "$bucket" != *..* && ! "$bucket" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
}

valid_prefix() {
  local prefix=$1 segment
  local -a segments
  [[ "$prefix" == */* && "$prefix" != /* && "$prefix" != */ ]] || return 1
  IFS='/' read -r -a segments <<< "$prefix"
  for segment in "${segments[@]}"; do
    [[ "$segment" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
    [[ "$segment" != . && "$segment" != .. ]] || return 1
  done
}

valid_pg_host() {
  local host=${1%.}
  [[ ${#host} -ge 1 && ${#host} -le 253 ]] || return 1
  [[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]] || return 1
  [[ "$host" != *..* ]]
}

valid_pg_database() {
  [[ ${#1} -le 63 && "$1" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]
}

valid_pg_user() {
  [[ ${#1} -le 63 && "$1" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ && "$1" != *..* ]]
}

valid_pg_host "$BACKUP_PGHOST" || die
valid_pg_database "$BACKUP_PGDATABASE" || die
[[ "$BACKUP_PGDATABASE" == 'postgres' ]] || die
valid_pg_user "$BACKUP_PGUSER" || die
valid_bucket "$BACKUP_SOURCE_BUCKET" || die
valid_bucket "$BACKUP_TARGET_BUCKET" || die
[[ "$BACKUP_SOURCE_BUCKET" == 'workspace-files' ]] || die
[[ "$BACKUP_SOURCE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || die
[[ "$BACKUP_SOURCE_REGION" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die
[[ "$BACKUP_SOURCE_AUTH_ANON_KEY" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || die
[[ "$BACKUP_SOURCE_SESSION_TOKEN" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] || die
valid_prefix "$BACKUP_TARGET_PREFIX" || die
[[ "$BACKUP_PGPORT" =~ ^[0-9]{1,5}$ ]] || die
(( 10#$BACKUP_PGPORT >= 1 && 10#$BACKUP_PGPORT <= 65535 )) || die
[[ "$BACKUP_PGSSLMODE" == 'verify-full' ]] || die
[[ ${#BACKUP_PGSSLROOTCERT_BASE64} -le 32768 ]] || die
[[ "$BACKUP_TARGET_ENCRYPTION" == 'AES256' || "$BACKUP_TARGET_ENCRYPTION" == 'aws:kms' ]] || die
[[ "$BACKUP_TARGET_REGION" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die
[[ "$BACKUP_TARGET_FORCE_PATH_STYLE" == 'true' || "$BACKUP_TARGET_FORCE_PATH_STYLE" == 'false' ]] || die
if [[ "$BACKUP_TARGET_ENCRYPTION" == 'aws:kms' ]]; then
  require_value BACKUP_TARGET_KMS_KEY_ID
fi

source_endpoint=$(node "$METADATA_HELPER" canonical-endpoint --value "$BACKUP_SOURCE_ENDPOINT" 2> /dev/null) || die
target_endpoint=$(node "$METADATA_HELPER" canonical-endpoint --value "$BACKUP_TARGET_ENDPOINT" 2> /dev/null) || die
[[ "$source_endpoint" == "https://$BACKUP_SOURCE_PROJECT_REF.storage.supabase.co/storage/v1/s3" ]] || die
if [[ "$BACKUP_PGUSER" == "smoking_zen_backup_reader.$BACKUP_SOURCE_PROJECT_REF" ]]; then
  [[ "$BACKUP_PGHOST" =~ ^[a-z0-9-]+\.pooler\.supabase\.com$ && "$BACKUP_PGPORT" == '5432' ]] || die
elif [[ "$BACKUP_PGUSER" == 'smoking_zen_backup_reader' ]]; then
  [[ "$BACKUP_PGHOST" == "db.$BACKUP_SOURCE_PROJECT_REF.supabase.co" && "$BACKUP_PGPORT" == '5432' ]] || die
else
  die
fi
endpoint_uses_supabase_provider() {
  local endpoint=$1
  case "$endpoint" in
    https://*.supabase.co|https://*.supabase.co/*|https://*.supabase.co:*) return 0 ;;
    *) return 1 ;;
  esac
}
if endpoint_uses_supabase_provider "$target_endpoint"; then
  die
fi

iso_from_snapshot() {
  local snapshot=$1
  printf '%s-%s-%sT%s:%s:%s.000Z' \
    "${snapshot:0:4}" "${snapshot:4:2}" "${snapshot:6:2}" \
    "${snapshot:9:2}" "${snapshot:11:2}" "${snapshot:13:2}"
}
utc_now() {
  local value
  value=$(date -u +%Y%m%dT%H%M%SZ) || die
  [[ "$value" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die
  iso_from_snapshot "$value"
}
snapshot_id=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$snapshot_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die
started_at=$(iso_from_snapshot "$snapshot_id")

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/smoking-zen-backup.XXXXXXXX") || die
chmod 700 "$SCRATCH" || die
provider_log="$SCRATCH/provider.log"
config_file="$SCRATCH/rclone.conf"
pgpass_file="$SCRATCH/pgpass"
pg_ssl_root_cert="$SCRATCH/pg-root-ca.pem"
: > "$provider_log"
: > "$config_file"
chmod 600 "$provider_log" "$config_file"
PG_CA_BASE64="$BACKUP_PGSSLROOTCERT_BASE64" node "$METADATA_HELPER" write-pg-ca \
  --output "$pg_ssl_root_cert" 2>> "$provider_log" || die
chmod 600 "$pg_ssl_root_cert" || die

escape_pgpass_field() {
  local value=$1
  value=${value//\\/\\\\}
  printf '%s' "${value//:/\\:}"
}
pg_host=$BACKUP_PGHOST
pg_port=$BACKUP_PGPORT
pg_database=$BACKUP_PGDATABASE
pg_user=$BACKUP_PGUSER
pg_sslmode=$BACKUP_PGSSLMODE
source_access_key=$BACKUP_SOURCE_PROJECT_REF
source_secret_key=$BACKUP_SOURCE_AUTH_ANON_KEY
source_session_token=$BACKUP_SOURCE_SESSION_TOKEN
source_region=$BACKUP_SOURCE_REGION
target_access_key=$BACKUP_TARGET_ACCESS_KEY_ID
target_secret_key=$BACKUP_TARGET_SECRET_ACCESS_KEY
target_encryption=$BACKUP_TARGET_ENCRYPTION
target_region=$BACKUP_TARGET_REGION
target_force_path_style=$BACKUP_TARGET_FORCE_PATH_STYLE
target_kms_key=${BACKUP_TARGET_KMS_KEY_ID:-}
printf '%s:%s:%s:%s:%s\n' \
  "$(escape_pgpass_field "$pg_host")" "$(escape_pgpass_field "$pg_port")" \
  "$(escape_pgpass_field "$pg_database")" "$(escape_pgpass_field "$pg_user")" \
  "$(escape_pgpass_field "$BACKUP_PGPASSWORD")" \
  > "$pgpass_file"
chmod 600 "$pgpass_file"

unset BACKUP_PGPASSWORD BACKUP_PGSSLROOTCERT_BASE64 BACKUP_SOURCE_AUTH_ANON_KEY BACKUP_SOURCE_SESSION_TOKEN \
  BACKUP_TARGET_ACCESS_KEY_ID BACKUP_TARGET_SECRET_ACCESS_KEY BACKUP_TARGET_KMS_KEY_ID

run_pg() {
  (
    unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE \
      PGSERVICE PGSERVICEFILE PGOPTIONS PGAPPNAME PGCONNECT_TIMEOUT PGCLIENTENCODING \
      PGDATESTYLE PGTZ PGGEQO PGSYSCONFDIR PGLOCALEDIR PGREQUIRESSL PGSSLMODE \
      PGSSLCOMPRESSION PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGSSLCRLDIR \
      PGSSLSNI PGREQUIREPEER PGCHANNELBINDING PGTARGETSESSIONATTRS PGLOADBALANCEHOSTS \
      PGKRBSRVNAME PGGSSLIB PGREALM PGGSSENCMODE PGSSLMINPROTOCOLVERSION \
      PGSSLMAXPROTOCOLVERSION PGSSLNEGOTIATION PGREQUIREAUTH PG_COLOR
    if [[ ${1##*/} == psql ]]; then
      pg_command=$1
      shift
      set -- "$pg_command" -v ON_ERROR_STOP=1 "$@"
    fi
    PGHOST="$pg_host" PGPORT="$pg_port" PGDATABASE="$pg_database" PGUSER="$pg_user" \
      PGSSLMODE="$pg_sslmode" PGSSLROOTCERT="$pg_ssl_root_cert" PGPASSFILE="$pgpass_file" "$@"
  )
}

run_rclone() {
  RCLONE_CONFIG_SOURCE_TYPE='s3' RCLONE_CONFIG_SOURCE_PROVIDER='Other' \
    RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID="$source_access_key" \
    RCLONE_CONFIG_SOURCE_SECRET_ACCESS_KEY="$source_secret_key" \
    RCLONE_CONFIG_SOURCE_SESSION_TOKEN="$source_session_token" \
    RCLONE_CONFIG_SOURCE_REGION="$source_region" \
    RCLONE_CONFIG_SOURCE_FORCE_PATH_STYLE='true' \
    RCLONE_CONFIG_SOURCE_ENDPOINT="$source_endpoint" \
    RCLONE_CONFIG_TARGET_TYPE='s3' RCLONE_CONFIG_TARGET_PROVIDER='Other' \
    RCLONE_CONFIG_TARGET_ACCESS_KEY_ID="$target_access_key" \
    RCLONE_CONFIG_TARGET_SECRET_ACCESS_KEY="$target_secret_key" \
    RCLONE_CONFIG_TARGET_ENDPOINT="$target_endpoint" \
    RCLONE_CONFIG_TARGET_REGION="$target_region" \
    RCLONE_CONFIG_TARGET_FORCE_PATH_STYLE="$target_force_path_style" \
    RCLONE_CONFIG_TARGET_SERVER_SIDE_ENCRYPTION="$target_encryption" \
    RCLONE_CONFIG_TARGET_SSE_KMS_KEY_ID="$target_kms_key" \
    rclone "$@"
}

source_remote="source:$BACKUP_SOURCE_BUCKET"
target_base="target:$BACKUP_TARGET_BUCKET/$BACKUP_TARGET_PREFIX"
snapshot_remote="$target_base/$snapshot_id"
raw_inventory="$SCRATCH/source-inventory.json"
inventory="$SCRATCH/inventory.json"
inventory_paths="$SCRATCH/inventory.paths"
target_dirs="$SCRATCH/target-dirs"
manifest_dir="$SCRATCH/manifests"
source_probe="$SCRATCH/source-probe"
server_version_file="$SCRATCH/server-version-num"
mkdir -m 700 "$manifest_dir"

# All connectivity, collision, and retention discovery happens before any dump,
# object copy, upload, or deletion.
run_pg psql -XAt --no-password --command 'show server_version_num' \
  > "$server_version_file" 2>> "$provider_log" || die
IFS= read -r database_server_version_num < "$server_version_file" || die
[[ "$database_server_version_num" =~ ^[1-9][0-9]{5}$ ]] || die
database_server_major=$((10#$database_server_version_num / 10000))
backup_role_guard=$(run_pg psql -XAt --no-password --command "
  select (
    current_user = 'smoking_zen_backup_reader'
    and exists (
      select 1 from pg_catalog.pg_roles role
      where role.rolname = current_user and role.rolcanlogin and role.rolbypassrls
        and not role.rolinherit and not role.rolsuper and not role.rolcreatedb
        and not role.rolcreaterole and not role.rolreplication
        and role.rolconfig @> array[
          'default_transaction_read_only=on',
          'statement_timeout=55min',
          'idle_in_transaction_session_timeout=55min',
          'idle_session_timeout=55min'
        ]
    )
    and has_database_privilege(current_user, current_database(), 'CONNECT')
    and has_schema_privilege(current_user, 'public', 'USAGE')
    and has_schema_privilege(current_user, 'private', 'USAGE')
    and not exists (
      select 1 from pg_catalog.pg_auth_members membership
      join pg_catalog.pg_roles role on role.oid in (membership.roleid, membership.member)
      where role.rolname = current_user
    )
    and not exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'private') and relation.relkind in ('r', 'p')
        and not has_table_privilege(current_user, relation.oid, 'SELECT')
    )
    and not exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'private') and relation.relkind in ('r', 'p')
        and (has_table_privilege(current_user, relation.oid, 'INSERT')
          or has_table_privilege(current_user, relation.oid, 'UPDATE')
          or has_table_privilege(current_user, relation.oid, 'DELETE')
          or has_table_privilege(current_user, relation.oid, 'TRUNCATE')
          or has_table_privilege(current_user, relation.oid, 'REFERENCES')
          or has_table_privilege(current_user, relation.oid, 'TRIGGER'))
    )
    and not exists (
      select 1 from pg_catalog.pg_class sequence
      join pg_catalog.pg_namespace namespace on namespace.oid = sequence.relnamespace
      where namespace.nspname in ('public', 'private') and sequence.relkind = 'S'
        and (not has_sequence_privilege(current_user, sequence.oid, 'SELECT')
          or has_sequence_privilege(current_user, sequence.oid, 'USAGE')
          or has_sequence_privilege(current_user, sequence.oid, 'UPDATE'))
    )
    and not exists (
      select 1 from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname in ('public', 'private') and routine.prosecdef
        and has_function_privilege(current_user, routine.oid, 'EXECUTE')
    )
    and not exists (
      select 1 from (
        select namespace.nspname, access.privilege_type
        from pg_catalog.pg_namespace namespace
        cross join lateral aclexplode(namespace.nspacl) access
        where access.grantee = (select oid from pg_catalog.pg_roles where rolname = current_user)
          and not (namespace.nspname in ('public', 'private') and access.privilege_type = 'USAGE')
        union all
        select namespace.nspname, access.privilege_type
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        cross join lateral aclexplode(relation.relacl) access
        where access.grantee = (select oid from pg_catalog.pg_roles where rolname = current_user)
          and not (namespace.nspname in ('public', 'private') and access.privilege_type = 'SELECT')
        union all
        select namespace.nspname, access.privilege_type
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        cross join lateral aclexplode(routine.proacl) access
        where access.grantee = (select oid from pg_catalog.pg_roles where rolname = current_user)
        union all
        select database.datname, access.privilege_type
        from pg_catalog.pg_database database
        cross join lateral aclexplode(database.datacl) access
        where access.grantee = (select oid from pg_catalog.pg_roles where rolname = current_user)
          and not (database.datname = current_database() and access.privilege_type = 'CONNECT')
        union all
        select coalesce(namespace.nspname, ''), access.privilege_type
        from pg_catalog.pg_default_acl defaults
        left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
        cross join lateral aclexplode(defaults.defaclacl) access
        where access.grantee = (select oid from pg_catalog.pg_roles where rolname = current_user)
          and not (namespace.nspname in ('public', 'private')
            and defaults.defaclobjtype in ('r', 'S') and access.privilege_type = 'SELECT')
      ) unexpected_direct_acl
    )
  ) as smoking_zen_backup_role_guard
" 2>> "$provider_log") || die
[[ "$backup_role_guard" == 't' ]] || die
parse_pg_client_version() {
  local raw=$1
  [[ "$raw" =~ PostgreSQL\)\ ([1-9][0-9]?\.[0-9]+(\.[0-9]+)?) ]] || die
  parsed_pg_client_version=${BASH_REMATCH[1]}
  parsed_pg_client_major=${parsed_pg_client_version%%.*}
}
pg_dump_version_raw=$(run_pg pg_dump --version 2>> "$provider_log") || die
parse_pg_client_version "$pg_dump_version_raw"
pg_dump_version=$parsed_pg_client_version
pg_dump_major=$parsed_pg_client_major
pg_restore_version_raw=$(run_pg pg_restore --version 2>> "$provider_log") || die
parse_pg_client_version "$pg_restore_version_raw"
[[ "$pg_dump_major" -eq "$database_server_major"
  && "$parsed_pg_client_major" -eq "$database_server_major" ]] || die
run_rclone lsf "$source_remote" --max-depth 1 --files-only --config "$config_file" \
  > "$source_probe" 2>> "$provider_log" || die
run_rclone lsf "$target_base" --dirs-only --max-depth 1 --config "$config_file" \
  > "$target_dirs" 2>> "$provider_log" || die

while IFS= read -r directory; do
  [[ "$directory" =~ ^([0-9]{8}T[0-9]{6}Z)/$ ]] || continue
  existing_id=${BASH_REMATCH[1]}
  [[ "$existing_id" != "$snapshot_id" ]] || die
  run_rclone cat "$target_base/$existing_id/manifest.json" --config "$config_file" \
    > "$SCRATCH/candidate-manifest" 2>> "$provider_log" || continue
  node "$METADATA_HELPER" validate-manifest \
    --manifest "$SCRATCH/candidate-manifest" --snapshot "$existing_id" \
    > "$manifest_dir/$existing_id.json" 2>> "$provider_log" || rm -f -- "$manifest_dir/$existing_id.json"
done < "$target_dirs"

node "$METADATA_HELPER" retention --directory "$manifest_dir" --now "$started_at" \
  --source-project-ref "$BACKUP_SOURCE_PROJECT_REF" \
  > "$SCRATCH/retention-plan.json" 2>> "$provider_log" || die

if [[ ${BACKUP_DRY_RUN:-0} == 1 ]]; then
  printf '%s\n' 'Backup dry run completed.'
  exit 0
fi
[[ ${BACKUP_DRY_RUN:-0} == 0 ]] || die

dump_file="$SCRATCH/database.dump"
toc_file="$SCRATCH/database.toc"
database_captured_at=$(utc_now)
snapshot_input="$SCRATCH/database-snapshot.in"
snapshot_output="$SCRATCH/database-snapshot.out"
database_ready_metadata="$SCRATCH/database-ready.json"
database_rows="$SCRATCH/database-rows.json"
mkfifo "$snapshot_input" "$snapshot_output" || die
run_pg psql -XAtq --no-password < "$snapshot_input" > "$snapshot_output" 2>> "$provider_log" &
DATABASE_SNAPSHOT_PID=$!
exec 3> "$snapshot_input"
DATABASE_SNAPSHOT_FD_OPEN=1
printf '%s\n' 'begin isolation level repeatable read, read only; select pg_export_snapshot();' >&3 || die
IFS= read -r database_snapshot < "$snapshot_output" || die
[[ "$database_snapshot" =~ ^[0-9A-Fa-f-]{3,128}$ ]] || die
run_pg psql -XAtq --no-password --command \
  "begin isolation level repeatable read, read only; set transaction snapshot '$database_snapshot'; select coalesce(json_agg(json_build_object('path', storage_path, 'size', size_bytes, 'sha256', sha256) order by storage_path), '[]'::json) as smoking_zen_ready_attachment_metadata from public.attachments where state = 'ready' and storage_cleanup_completed_at is null; commit" \
  > "$database_ready_metadata" 2>> "$provider_log" || die
run_pg psql -XAtq --no-password --command \
  "begin isolation level repeatable read, read only; set transaction snapshot '$database_snapshot'; select json_build_object('appUsers', (select count(*) from public.app_users), 'workspaces', (select count(*) from public.workspaces), 'memberships', (select count(*) from public.workspace_members), 'tasks', (select count(*) from public.tasks), 'knowledgeItems', (select count(*) from public.knowledge_items), 'contacts', (select count(*) from public.contacts), 'attachments', (select count(*) from public.attachments)) as smoking_zen_core_row_counts; commit" \
  > "$database_rows" 2>> "$provider_log" || die
run_pg pg_dump --format=custom --no-owner --no-privileges --no-password --strict-names \
  --schema=public --schema=private --snapshot="$database_snapshot" \
  --file="$dump_file" > /dev/null 2>> "$provider_log" || die
printf '%s\n' 'commit;' >&3 || die
exec 3>&-
DATABASE_SNAPSHOT_FD_OPEN=0
wait "$DATABASE_SNAPSHOT_PID" || die
DATABASE_SNAPSHOT_PID=''
[[ -s "$dump_file" ]] || die
run_pg pg_restore --list "$dump_file" > "$toc_file" 2>> "$provider_log" || die
[[ -s "$toc_file" ]] || die
node "$METADATA_HELPER" validate-toc --toc "$toc_file" > /dev/null 2>> "$provider_log" || die

# The database artifact is independently durable even if a later Storage copy fails.
run_rclone copyto "$dump_file" "$snapshot_remote/database.dump" --immutable --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
run_rclone copyto "$snapshot_remote/database.dump" "$SCRATCH/database.verify" --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
cmp -s "$dump_file" "$SCRATCH/database.verify" || die

storage_captured_at=$(utc_now)
run_rclone lsjson "$source_remote" --recursive --files-only --config "$config_file" \
  > "$raw_inventory" 2>> "$provider_log" || die
node "$METADATA_HELPER" inventory \
  --input "$raw_inventory" --paths "$inventory_paths" --output "$inventory" \
  --captured-at "$storage_captured_at" >> "$provider_log" 2>&1 || die
storage_dir="$SCRATCH/storage"
mkdir -m 700 "$storage_dir"
run_rclone copy "$source_remote" "$storage_dir" --files-from-raw "$inventory_paths" \
  --no-traverse --immutable --config "$config_file" > /dev/null 2>> "$provider_log" || die
checksums="$SCRATCH/storage-checksums.json"
node "$METADATA_HELPER" hash-tree \
  --inventory "$inventory" --root "$storage_dir" --output "$checksums" \
  >> "$provider_log" 2>&1 || die
node "$METADATA_HELPER" verify-tree --checksums "$checksums" --root "$storage_dir" \
  >> "$provider_log" 2>&1 || die
node "$METADATA_HELPER" ready-check --checksums "$checksums" --metadata "$database_ready_metadata" \
  > /dev/null 2>> "$provider_log" || die

run_rclone copyto "$checksums" "$snapshot_remote/storage-checksums.json" --immutable --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
run_rclone copyto "$snapshot_remote/storage-checksums.json" "$SCRATCH/checksums.verify" --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
cmp -s "$checksums" "$SCRATCH/checksums.verify" || die
run_rclone copy "$storage_dir" "$snapshot_remote/storage" --files-from-raw "$inventory_paths" \
  --no-traverse --immutable --config "$config_file" > /dev/null 2>> "$provider_log" || die
run_rclone check "$storage_dir" "$snapshot_remote/storage" --download --one-way --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
verified_storage="$SCRATCH/storage.verify"
mkdir -m 700 "$verified_storage"
run_rclone copy "$snapshot_remote/storage" "$verified_storage" --files-from-raw "$inventory_paths" \
  --no-traverse --immutable --config "$config_file" > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" verify-tree --checksums "$checksums" --root "$verified_storage" \
  > /dev/null 2>> "$provider_log" || die

completed_at=$(utc_now)
manifest="$SCRATCH/manifest.json"
node "$METADATA_HELPER" manifest \
  --snapshot "$snapshot_id" --source-project-ref "$BACKUP_SOURCE_PROJECT_REF" --started-at "$started_at" \
  --database-captured-at "$database_captured_at" --storage-captured-at "$storage_captured_at" \
  --completed-at "$completed_at" --dump "$dump_file" --toc "$toc_file" \
  --server-version-num "$database_server_version_num" --client-version "$pg_dump_version" \
  --checksums "$checksums" --rows "$database_rows" --output "$manifest" >> "$provider_log" 2>&1 || die
node "$METADATA_HELPER" freshness --manifest "$manifest" --now "$completed_at" \
  --source-project-ref "$BACKUP_SOURCE_PROJECT_REF" \
  > /dev/null 2>> "$provider_log" || die

# The completion marker is intentionally the final snapshot upload.
run_rclone copyto "$manifest" "$snapshot_remote/manifest.json" --immutable --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
cp "$manifest" "$manifest_dir/$snapshot_id.json"
node "$METADATA_HELPER" retention --directory "$manifest_dir" --now "$completed_at" \
  --source-project-ref "$BACKUP_SOURCE_PROJECT_REF" \
  > "$SCRATCH/retention-plan.json" 2>> "$provider_log" || die
# shellcheck disable=SC2016
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!value || !Array.isArray(value.delete)) process.exit(1);
  for (const id of value.delete) {
    if (!/^\d{8}T\d{6}Z$/.test(id)) process.exit(1);
    process.stdout.write(`${id}\n`);
  }
' "$SCRATCH/retention-plan.json" > "$SCRATCH/delete.ids" 2>> "$provider_log" || die
while IFS= read -r expired_id; do
  [[ "$expired_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die
  run_rclone purge "$target_base/$expired_id" --config "$config_file" \
    > /dev/null 2>> "$provider_log" || die
done < "$SCRATCH/delete.ids"

printf 'Backup completed: %s\n' "$snapshot_id"
