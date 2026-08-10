#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077

SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_PARENT=.
[[ "$SCRIPT_PATH" != */* ]] || SCRIPT_PARENT=${SCRIPT_PATH%/*}
SCRIPT_DIR=$(CDPATH='' cd -- "$SCRIPT_PARENT" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
METADATA_HELPER="$SCRIPT_DIR/backup-metadata.mjs"
ACL_HARDENING_FILE="$PROJECT_DIR/supabase/operations/restore_acl_0019.sql"
SCRATCH=''

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
    rm -r -- "$SCRATCH"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

die() {
  printf '%s\n' 'Restore drill failed.' >&2
  exit 1
}

require_value() {
  local name=$1
  [[ -n ${!name:-} ]] || die
  [[ ${!name} != *$'\n'* && ${!name} != *$'\r'* ]] || die
}

for variable in \
  BACKUP_PGHOST BACKUP_PGPORT BACKUP_PGDATABASE BACKUP_SOURCE_ENDPOINT BACKUP_SOURCE_BUCKET \
  RESTORE_ARCHIVE_ENDPOINT RESTORE_ARCHIVE_ACCESS_KEY_ID RESTORE_ARCHIVE_SECRET_ACCESS_KEY \
  RESTORE_ARCHIVE_BUCKET RESTORE_ARCHIVE_PREFIX RESTORE_ARCHIVE_REGION RESTORE_ARCHIVE_FORCE_PATH_STYLE \
  RESTORE_SNAPSHOT_ID RESTORE_TARGET_ENVIRONMENT RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT \
  RESTORE_SOURCE_PROJECT_REF RESTORE_TARGET_PROJECT_REF \
  RESTORE_PGHOST RESTORE_PGPORT RESTORE_PGDATABASE RESTORE_PGUSER RESTORE_PGPASSWORD RESTORE_PGSSLMODE \
  RESTORE_PGSSLROOTCERT_BASE64 \
  RESTORE_TARGET_ENDPOINT RESTORE_TARGET_ACCESS_KEY_ID RESTORE_TARGET_SECRET_ACCESS_KEY RESTORE_TARGET_BUCKET \
  RESTORE_TARGET_REGION RESTORE_TARGET_FORCE_PATH_STYLE; do
  require_value "$variable"
done
for tool in node rclone psql pg_restore date mktemp chmod rm mkdir cmp tr; do
  command -v "$tool" >/dev/null 2>&1 || die
done
[[ -f "$METADATA_HELPER" ]] || die
[[ -f "$ACL_HARDENING_FILE" ]] || die

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

[[ "$RESTORE_SNAPSHOT_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die
[[ "$RESTORE_TARGET_ENVIRONMENT" == 'restore-drill' ]] || die
[[ "$RESTORE_DESTRUCTIVE_ACKNOWLEDGEMENT" == 'RESTORE_ISOLATED_TARGET' ]] || die
[[ "$RESTORE_SOURCE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || die
[[ "$RESTORE_TARGET_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || die
[[ "$RESTORE_SOURCE_PROJECT_REF" != "$RESTORE_TARGET_PROJECT_REF" ]] || die
[[ "$RESTORE_TARGET_PROJECT_REF" != 'prod' && "$RESTORE_TARGET_PROJECT_REF" != 'production' ]] || die
valid_bucket "$BACKUP_SOURCE_BUCKET" || die
valid_bucket "$RESTORE_ARCHIVE_BUCKET" || die
valid_bucket "$RESTORE_TARGET_BUCKET" || die
valid_prefix "$RESTORE_ARCHIVE_PREFIX" || die
[[ "$RESTORE_ARCHIVE_REGION" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die
[[ "$RESTORE_TARGET_REGION" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die
[[ "$RESTORE_ARCHIVE_FORCE_PATH_STYLE" == 'true' || "$RESTORE_ARCHIVE_FORCE_PATH_STYLE" == 'false' ]] || die
[[ "$RESTORE_TARGET_FORCE_PATH_STYLE" == 'true' || "$RESTORE_TARGET_FORCE_PATH_STYLE" == 'false' ]] || die
[[ "$BACKUP_SOURCE_BUCKET" == 'workspace-files' ]] || die
[[ "$RESTORE_TARGET_BUCKET" == 'workspace-files' ]] || die
valid_pg_host "$BACKUP_PGHOST" || die
valid_pg_host "$RESTORE_PGHOST" || die
valid_pg_database "$BACKUP_PGDATABASE" || die
valid_pg_database "$RESTORE_PGDATABASE" || die
[[ "$BACKUP_PGDATABASE" == 'postgres' && "$RESTORE_PGDATABASE" == 'postgres' ]] || die
valid_pg_user "$RESTORE_PGUSER" || die
[[ "$BACKUP_PGPORT" =~ ^[0-9]{1,5}$ ]] || die
[[ "$RESTORE_PGPORT" =~ ^[0-9]{1,5}$ ]] || die
(( 10#$BACKUP_PGPORT >= 1 && 10#$BACKUP_PGPORT <= 65535 )) || die
(( 10#$RESTORE_PGPORT >= 1 && 10#$RESTORE_PGPORT <= 65535 )) || die
[[ "$RESTORE_PGSSLMODE" == 'verify-full' ]] || die
[[ ${#RESTORE_PGSSLROOTCERT_BASE64} -le 32768 ]] || die
[[ "$RESTORE_PGDATABASE" != 'template0' && "$RESTORE_PGDATABASE" != 'template1' ]] || die
if [[ "$RESTORE_PGUSER" == "postgres.$RESTORE_TARGET_PROJECT_REF" ]]; then
  [[ "$RESTORE_PGHOST" =~ ^[a-z0-9-]+\.pooler\.supabase\.com$ && "$RESTORE_PGPORT" == '5432' ]] || die
elif [[ "$RESTORE_PGUSER" == 'postgres' ]]; then
  [[ "$RESTORE_PGHOST" == "db.$RESTORE_TARGET_PROJECT_REF.supabase.co" && "$RESTORE_PGPORT" == '5432' ]] || die
else
  die
fi
canonical_pg_host() {
  local host=${1%.}
  printf '%s' "$host" | tr '[:upper:]' '[:lower:]'
}
source_pg_identity="$(canonical_pg_host "$BACKUP_PGHOST")/$((10#$BACKUP_PGPORT))/$BACKUP_PGDATABASE"
restore_pg_identity="$(canonical_pg_host "$RESTORE_PGHOST")/$((10#$RESTORE_PGPORT))/$RESTORE_PGDATABASE"
[[ "$restore_pg_identity" != "$source_pg_identity" ]] || die
source_endpoint=$(node "$METADATA_HELPER" canonical-endpoint --value "$BACKUP_SOURCE_ENDPOINT" 2> /dev/null) || die
archive_endpoint=$(node "$METADATA_HELPER" canonical-endpoint --value "$RESTORE_ARCHIVE_ENDPOINT" 2> /dev/null) || die
restore_endpoint=$(node "$METADATA_HELPER" canonical-endpoint --value "$RESTORE_TARGET_ENDPOINT" 2> /dev/null) || die
[[ "$source_endpoint" == "https://$RESTORE_SOURCE_PROJECT_REF.storage.supabase.co/storage/v1/s3" ]] || die
[[ "$restore_endpoint" == "https://$RESTORE_TARGET_PROJECT_REF.storage.supabase.co/storage/v1/s3" ]] || die
endpoint_uses_supabase_provider() {
  local endpoint=$1
  case "$endpoint" in
    https://*.supabase.co|https://*.supabase.co/*|https://*.supabase.co:*) return 0 ;;
    *) return 1 ;;
  esac
}
if endpoint_uses_supabase_provider "$archive_endpoint"; then
  die
fi

evidence_dir="$PROJECT_DIR/backups"
evidence_file="$evidence_dir/restore-drill-$RESTORE_SNAPSHOT_ID.json"
[[ ! -e "$evidence_file" ]] || die

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/smoking-zen-restore.XXXXXXXX") || die
chmod 700 "$SCRATCH" || die
provider_log="$SCRATCH/provider.log"
config_file="$SCRATCH/rclone.conf"
pgpass_file="$SCRATCH/pgpass"
pg_ssl_root_cert="$SCRATCH/pg-root-ca.pem"
: > "$provider_log"
: > "$config_file"
chmod 600 "$provider_log" "$config_file"
PG_CA_BASE64="$RESTORE_PGSSLROOTCERT_BASE64" node "$METADATA_HELPER" write-pg-ca \
  --output "$pg_ssl_root_cert" 2>> "$provider_log" || die
chmod 600 "$pg_ssl_root_cert" || die
escape_pgpass_field() {
  local value=$1
  value=${value//\\/\\\\}
  printf '%s' "${value//:/\\:}"
}
pg_host=$RESTORE_PGHOST
pg_port=$RESTORE_PGPORT
pg_database=$RESTORE_PGDATABASE
pg_user=$RESTORE_PGUSER
pg_sslmode=$RESTORE_PGSSLMODE
archive_access_key=$RESTORE_ARCHIVE_ACCESS_KEY_ID
archive_secret_key=$RESTORE_ARCHIVE_SECRET_ACCESS_KEY
restore_access_key=$RESTORE_TARGET_ACCESS_KEY_ID
restore_secret_key=$RESTORE_TARGET_SECRET_ACCESS_KEY
archive_region=$RESTORE_ARCHIVE_REGION
archive_force_path_style=$RESTORE_ARCHIVE_FORCE_PATH_STYLE
restore_region=$RESTORE_TARGET_REGION
restore_force_path_style=$RESTORE_TARGET_FORCE_PATH_STYLE
printf '%s:%s:%s:%s:%s\n' \
  "$(escape_pgpass_field "$pg_host")" "$(escape_pgpass_field "$pg_port")" \
  "$(escape_pgpass_field "$pg_database")" "$(escape_pgpass_field "$pg_user")" \
  "$(escape_pgpass_field "$RESTORE_PGPASSWORD")" \
  > "$pgpass_file"
chmod 600 "$pgpass_file"

unset RESTORE_PGPASSWORD RESTORE_PGSSLROOTCERT_BASE64 \
  RESTORE_ARCHIVE_ACCESS_KEY_ID RESTORE_ARCHIVE_SECRET_ACCESS_KEY \
  RESTORE_TARGET_ACCESS_KEY_ID RESTORE_TARGET_SECRET_ACCESS_KEY

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
  RCLONE_CONFIG_ARCHIVE_TYPE='s3' RCLONE_CONFIG_ARCHIVE_PROVIDER='Other' \
    RCLONE_CONFIG_ARCHIVE_ACCESS_KEY_ID="$archive_access_key" \
    RCLONE_CONFIG_ARCHIVE_SECRET_ACCESS_KEY="$archive_secret_key" \
    RCLONE_CONFIG_ARCHIVE_ENDPOINT="$archive_endpoint" \
    RCLONE_CONFIG_ARCHIVE_REGION="$archive_region" \
    RCLONE_CONFIG_ARCHIVE_FORCE_PATH_STYLE="$archive_force_path_style" \
    RCLONE_CONFIG_RESTORE_TARGET_TYPE='s3' RCLONE_CONFIG_RESTORE_TARGET_PROVIDER='Other' \
    RCLONE_CONFIG_RESTORE_TARGET_ACCESS_KEY_ID="$restore_access_key" \
    RCLONE_CONFIG_RESTORE_TARGET_SECRET_ACCESS_KEY="$restore_secret_key" \
    RCLONE_CONFIG_RESTORE_TARGET_ENDPOINT="$restore_endpoint" \
    RCLONE_CONFIG_RESTORE_TARGET_REGION="$restore_region" \
    RCLONE_CONFIG_RESTORE_TARGET_FORCE_PATH_STYLE="$restore_force_path_style" \
    rclone "$@"
}

archive_snapshot="archive:$RESTORE_ARCHIVE_BUCKET/$RESTORE_ARCHIVE_PREFIX/$RESTORE_SNAPSHOT_ID"
restore_remote="restore-target:$RESTORE_TARGET_BUCKET"
manifest="$SCRATCH/manifest.json"
dump_file="$SCRATCH/database.dump"
toc_file="$SCRATCH/database.toc"
checksums="$SCRATCH/storage-checksums.json"
paths_file="$SCRATCH/storage.paths"
storage_before="$SCRATCH/target-before"

started_id=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$started_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die
iso_from_id() {
  local value=$1
  printf '%s-%s-%sT%s:%s:%s.000Z' \
    "${value:0:4}" "${value:4:2}" "${value:6:2}" \
    "${value:9:2}" "${value:11:2}" "${value:13:2}"
}
started_at=$(iso_from_id "$started_id")

server_version_file="$SCRATCH/server-version-num"
run_pg psql -XAt --no-password --command 'show server_version_num' \
  > "$server_version_file" 2>> "$provider_log" || die
IFS= read -r target_server_version_num < "$server_version_file" || die
[[ "$target_server_version_num" =~ ^[1-9][0-9]{5}$ ]] || die
pg_restore_version_raw=$(run_pg pg_restore --version 2>> "$provider_log") || die
[[ "$pg_restore_version_raw" =~ PostgreSQL\)\ ([1-9][0-9]?\.[0-9]+(\.[0-9]+)?) ]] || die
pg_restore_version=${BASH_REMATCH[1]}

check_empty_target_database() {
  run_pg psql -XAt --no-password --command \
    "select (not exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r','p','v','m','S','f')) and not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')) and not exists (select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace where n.nspname in ('public', 'private') and t.typtype in ('c','d','e','r','m'))) as smoking_zen_restore_target_empty" \
    > "$SCRATCH/database-empty" 2>> "$provider_log" || die
  local verdict
  IFS= read -r verdict < "$SCRATCH/database-empty" || die
  [[ "$verdict" == 't' ]] || die
}

# All destructive guards and every backup byte are verified before pg_restore.
run_pg psql -XAt --no-password --command \
  "select current_setting('smoking_zen.restore_drill', true) = 'true' and exists (select 1 from pg_catalog.pg_db_role_setting s cross join lateral unnest(s.setconfig) setting where s.setdatabase = (select oid from pg_catalog.pg_database where datname = current_database()) and s.setrole = 0 and setting = 'smoking_zen.restore_drill=true') as smoking_zen_restore_drill_guard" \
  > "$SCRATCH/database-guard" 2>> "$provider_log" || die
IFS= read -r database_guard < "$SCRATCH/database-guard" || die
[[ "$database_guard" == 't' ]] || die
check_empty_target_database
run_rclone lsf "$restore_remote" --recursive --files-only --config "$config_file" \
  > "$storage_before" 2>> "$provider_log" || die
[[ ! -s "$storage_before" ]] || die

run_rclone copyto "$archive_snapshot/manifest.json" "$manifest" --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" validate-manifest --manifest "$manifest" --snapshot "$RESTORE_SNAPSHOT_ID" \
  > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" postgres-compatibility --manifest "$manifest" \
  --source-project-ref "$RESTORE_SOURCE_PROJECT_REF" \
  --target-server-version-num "$target_server_version_num" --restore-client-version "$pg_restore_version" \
  > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" restore-preflight --manifest "$manifest" --started-at "$started_at" \
  > /dev/null 2>> "$provider_log" || die
run_rclone copyto "$archive_snapshot/database.dump" "$dump_file" --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
run_rclone copyto "$archive_snapshot/storage-checksums.json" "$checksums" --config "$config_file" \
  > /dev/null 2>> "$provider_log" || die
run_pg pg_restore --list "$dump_file" > "$toc_file" 2>> "$provider_log" || die
node "$METADATA_HELPER" validate-toc --toc "$toc_file" > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" verify-artifacts \
  --manifest "$manifest" --snapshot "$RESTORE_SNAPSHOT_ID" --dump "$dump_file" \
  --toc "$toc_file" --checksums "$checksums" > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" checksum-paths --checksums "$checksums" --output "$paths_file" \
  > /dev/null 2>> "$provider_log" || die

backup_storage="$SCRATCH/backup-storage"
mkdir -m 700 "$backup_storage"
run_rclone copy "$archive_snapshot/storage" "$backup_storage" --files-from-raw "$paths_file" \
  --no-traverse --immutable --config "$config_file" > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" verify-tree --checksums "$checksums" --root "$backup_storage" \
  > /dev/null 2>> "$provider_log" || die

run_rclone lsf "$restore_remote" --recursive --files-only --config "$config_file" \
  > "$storage_before" 2>> "$provider_log" || die
[[ ! -s "$storage_before" ]] || die
check_empty_target_database

run_pg pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges \
  --no-password --single-transaction --schema=public --schema=private \
  --dbname "$RESTORE_PGDATABASE" "$dump_file" \
  > /dev/null 2>> "$provider_log" || die

business_digest_sql="select md5(jsonb_build_object(
  'app_users', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.app_users row_value),
  'workspaces', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.workspaces row_value),
  'workspace_members', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.workspace_members row_value),
  'task_statuses', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.task_statuses row_value),
  'sections', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.sections row_value),
  'tasks', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.tasks row_value),
  'comments', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.comments row_value),
  'knowledge_items', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.knowledge_items row_value),
  'contacts', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.contacts row_value),
  'contact_methods', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.contact_methods row_value),
  'secure_items', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.secure_items row_value),
  'attachments', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.attachments row_value),
  'invitations', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.invitations row_value),
  'reminders', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.reminders row_value),
  'audit_events', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.audit_events row_value),
  'notification_outbox', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.notification_outbox row_value),
  'notification_deliveries', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.notification_deliveries row_value),
  'file_cleanup_queue', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.file_cleanup_queue row_value),
  'global_file_orphan_queue', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.global_file_orphan_queue row_value),
  'telegram_webhook_updates', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.telegram_webhook_updates row_value),
  'telegram_session_rate_limits', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(to_jsonb(row_value)::text), '' order by md5(to_jsonb(row_value)::text)), ''))) from public.telegram_session_rate_limits row_value)
)::text) as smoking_zen_business_digest"
business_digest_before=$(run_pg psql -XAt --no-password --command "$business_digest_sql" \
  2>> "$provider_log") || die
[[ "$business_digest_before" =~ ^[0-9a-f]{32}$ ]] || die
run_pg psql -X --no-password --file "$ACL_HARDENING_FILE" \
  > /dev/null 2>> "$provider_log" || die
business_digest_after=$(run_pg psql -XAt --no-password --command "$business_digest_sql" \
  2>> "$provider_log") || die
[[ "$business_digest_after" == "$business_digest_before" ]] || die
restore_acl_guard=$(run_pg psql -XAt --no-password --command "
  select (
    not has_table_privilege('anon', 'public.tasks', 'SELECT')
    and not has_table_privilege('authenticated', 'public.tasks', 'SELECT')
    and has_table_privilege('service_role', 'public.tasks', 'SELECT')
    and not has_function_privilege('anon', 'public.replay_notification_outbox(uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.replay_notification_outbox(uuid,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.replay_notification_outbox(uuid,text)', 'EXECUTE')
    and not has_table_privilege('anon', 'storage.objects', 'SELECT')
    and not has_table_privilege('authenticated', 'storage.objects', 'INSERT')
    and (select relrowsecurity from pg_catalog.pg_class where oid = 'realtime.messages'::regclass)
    and 1 = (
      select count(*) from pg_catalog.pg_policy policy
      where policy.polrelid = 'realtime.messages'::regclass
        and policy.polname = 'workspace_broadcast_realtime_select'
        and policy.polcmd = 'r'
        and policy.polpermissive
        and policy.polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]
        and pg_get_expr(policy.polqual, policy.polrelid) like '%smoking_zen_scope%'
        and pg_get_expr(policy.polqual, policy.polrelid) like '%workspace_id%'
        and pg_get_expr(policy.polqual, policy.polrelid) like '%is_workspace_member%'
    )
    and exists (
      select 1 from storage.buckets where id = 'workspace-files' and public = false
    )
    and not exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
        and not relation.relrowsecurity
    )
  ) as smoking_zen_restore_acl_guard
" 2>> "$provider_log") || die
[[ "$restore_acl_guard" == 't' ]] || die

run_rclone copy "$backup_storage" "$restore_remote" --files-from-raw "$paths_file" \
  --no-traverse --immutable --config "$config_file" > /dev/null 2>> "$provider_log" || die
post_storage="$SCRATCH/post-storage"
mkdir -m 700 "$post_storage"
post_paths="$SCRATCH/post-storage.paths"
run_rclone lsf "$restore_remote" --recursive --files-only --config "$config_file" \
  > "$post_paths" 2>> "$provider_log" || die
cmp -s "$paths_file" "$post_paths" || die
run_rclone copy "$restore_remote" "$post_storage" --files-from-raw "$paths_file" \
  --no-traverse --immutable --config "$config_file" > /dev/null 2>> "$provider_log" || die
node "$METADATA_HELPER" verify-tree --checksums "$checksums" --root "$post_storage" \
  > /dev/null 2>> "$provider_log" || die

rows="$SCRATCH/rows.json"
run_pg psql -XAt --no-password --command \
  "select json_build_object('appUsers', (select count(*) from public.app_users), 'workspaces', (select count(*) from public.workspaces), 'memberships', (select count(*) from public.workspace_members), 'tasks', (select count(*) from public.tasks), 'knowledgeItems', (select count(*) from public.knowledge_items), 'contacts', (select count(*) from public.contacts), 'attachments', (select count(*) from public.attachments)) as smoking_zen_core_row_counts" \
  > "$SCRATCH/restored-rows.json" 2>> "$provider_log" || die
node "$METADATA_HELPER" verify-row-counts --manifest "$manifest" \
  --rows "$SCRATCH/restored-rows.json" > "$rows" 2>> "$provider_log" || die
ready_metadata="$SCRATCH/ready.json"
run_pg psql -XAt --no-password --command \
  "select coalesce(json_agg(json_build_object('path', storage_path, 'size', size_bytes, 'sha256', sha256) order by storage_path), '[]'::json) as smoking_zen_ready_attachment_metadata from public.attachments where state = 'ready' and storage_cleanup_completed_at is null" \
  > "$ready_metadata" 2>> "$provider_log" || die
node "$METADATA_HELPER" ready-check --checksums "$checksums" --metadata "$ready_metadata" \
  > /dev/null 2>> "$provider_log" || die

completed_id=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$completed_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die
completed_at=$(iso_from_id "$completed_id")
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
node "$METADATA_HELPER" evidence \
  --manifest "$manifest" --started-at "$started_at" --completed-at "$completed_at" \
  --rows "$rows" --output "$evidence_file" > /dev/null 2>> "$provider_log" || die
chmod 600 "$evidence_file" || die
printf 'Restore drill completed: %s\n' "$RESTORE_SNAPSHOT_ID"
