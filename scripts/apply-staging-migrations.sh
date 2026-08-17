#!/usr/bin/env bash

set -Eeuo pipefail
set +x
IFS=$'\n\t'
umask 077
export LC_ALL=C
exec 3>&2
exec 2>/dev/null

SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_PARENT=.
[[ "$SCRIPT_PATH" != */* ]] || SCRIPT_PARENT=${SCRIPT_PATH%/*}
SCRIPT_DIR=$(CDPATH='' cd -- "$SCRIPT_PARENT" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
MIGRATION_DIR="$PROJECT_DIR/supabase/migrations"
IDENTITY_MANIFEST="$PROJECT_DIR/config/staging-identities.json"
SCRATCH=''

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
    rm -r -- "$SCRATCH" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  local status=${1:-1}
  printf '%s\n' 'Staging migration operation failed.' >&3
  exit "$status"
}

require_value() {
  local name=$1
  [[ -n ${!name:-} ]] || fail
  [[ ${!name} != *$'\n'* && ${!name} != *$'\r'* ]] || fail
}

[[ $# -eq 0 ]] || fail

for variable in \
  APP_MODE DEPLOYMENT_ENVIRONMENT STAGING_EXPECTED_SUPABASE_PROJECT_REF \
  STAGING_MIGRATION_ACKNOWLEDGEMENT STAGING_RELEASE_COMMIT STAGING_MIGRATION_MODE \
  PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE; do
  require_value "$variable"
done

[[ "$APP_MODE" == production ]] || fail
[[ "$DEPLOYMENT_ENVIRONMENT" == staging ]] || fail
[[ "$STAGING_EXPECTED_SUPABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] || fail
[[ "$STAGING_MIGRATION_ACKNOWLEDGEMENT" == \
  "APPLY_STAGING_MIGRATIONS:$STAGING_EXPECTED_SUPABASE_PROJECT_REF" ]] || fail
[[ "$STAGING_RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail
[[ "$STAGING_MIGRATION_MODE" == apply || "$STAGING_MIGRATION_MODE" == reapply ]] || fail
[[ "$PGPORT" == 5432 ]] || fail
[[ "$PGDATABASE" == postgres ]] || fail
[[ "$PGSSLMODE" == verify-full ]] || fail

for variable in PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSFILE; do
  [[ -z ${!variable:-} ]] || fail
done

if [[ "$PGHOST" == "db.$STAGING_EXPECTED_SUPABASE_PROJECT_REF.supabase.co" ]]; then
  [[ "$PGUSER" == postgres ]] || fail
elif [[ "$PGHOST" =~ ^[a-z0-9-]+[.]pooler[.]supabase[.]com$ ]]; then
  [[ "$PGUSER" == "postgres.$STAGING_EXPECTED_SUPABASE_PROJECT_REF" ]] || fail
else
  fail
fi

if [[ -n ${PGSSLROOTCERT:-} ]]; then
  [[ "$PGSSLROOTCERT" != *$'\n'* && "$PGSSLROOTCERT" != *$'\r'* ]] || fail
  [[ -f "$PGSSLROOTCERT" && -r "$PGSSLROOTCERT" ]] || fail
fi

for tool in git node psql mktemp chmod rm mkdir cp tr; do
  command -v "$tool" >/dev/null 2>&1 || fail
done
if command -v shasum >/dev/null 2>&1; then
  SHA256_TOOL=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256_TOOL=sha256sum
else
  fail
fi

[[ -f "$IDENTITY_MANIFEST" && ! -L "$IDENTITY_MANIFEST" ]] || fail
manifest_project_ref=$(
  node - "$IDENTITY_MANIFEST" 2>/dev/null <<'NODE'
const { readFileSync } = require('node:fs');
const filename = process.argv[2];
const source = readFileSync(filename);
if (source.byteLength > 16_384) process.exit(1);
const sourceText = source.toString('utf8');
const manifest = JSON.parse(sourceText);
if (sourceText !== `${JSON.stringify(manifest, null, 2)}\n`) process.exit(1);
const expectedKeys = [
  'schemaVersion', 'configured', 'githubRepository', 'appOrigin', 'supabaseProjectRef',
  'supabaseDrillProjectRef', 'telegramBotId',
  'telegramBotUsername', 'telegramMiniAppShortName', 'supabaseJwtKid',
  'supabaseJwtPublicKeySpkiSha256', 'backupTargetEndpoint', 'backupTargetBucket',
  'backupTargetPrefix',
].sort();
const actualKeys = Object.keys(manifest).sort();
if (actualKeys.length !== expectedKeys.length
  || actualKeys.some((key, index) => key !== expectedKeys[index])
  || manifest.schemaVersion !== 1 || manifest.configured !== true
  || typeof manifest.supabaseProjectRef !== 'string'
  || !/^[a-z0-9]{20}$/.test(manifest.supabaseProjectRef)) process.exit(1);
process.stdout.write(manifest.supabaseProjectRef);
NODE
) || fail
[[ "$manifest_project_ref" == "$STAGING_EXPECTED_SUPABASE_PROJECT_REF" ]] || fail

expected_migrations=(
  0001_workspace_schema.sql
  0002_rls_storage_realtime.sql
  0003_task_realtime_actor.sql
  0004_realtime_scope_lockdown.sql
  0005_audit_immutability.sql
  0006_knowledge_contacts_search.sql
  0007_task5_integrity.sql
  0008_task5_taxonomy_recovery.sql
  0009_private_files_secure_items.sql
  0010_task6_ambiguous_file_cleanup.sql
  0011_task6_late_cleanup_safe_convergence.sql
  0012_task6_cleanup_retirement_canonical_safe.sql
  0013_task6_quarantine_tombstones_safe_parity.sql
  0014_task6_explicit_cleanup_success_safe_url.sql
  0015_task7_notifications_cleanup.sql
  0016_task7_cleanup.sql
  0017_task7_notification_replay.sql
  0018_task8_acceptance_security.sql
  0019_task8_upload_abuse_guards.sql
)

[[ -d "$MIGRATION_DIR" ]] || fail
shopt -s nullglob dotglob
actual_migrations=("$MIGRATION_DIR"/*.sql)
shopt -u nullglob dotglob
[[ ${#actual_migrations[@]} -eq ${#expected_migrations[@]} ]] || fail
for ((index = 0; index < ${#expected_migrations[@]}; index += 1)); do
  [[ ${actual_migrations[index]##*/} == "${expected_migrations[index]}" ]] || fail
  [[ -f ${actual_migrations[index]} && ! -L ${actual_migrations[index]} ]] || fail
done

checkout_commit=$(git -C "$PROJECT_DIR" rev-parse --verify 'HEAD^{commit}' 2>/dev/null) || fail
[[ "$checkout_commit" == "$STAGING_RELEASE_COMMIT" ]] || fail
migration_git_status=$(git -C "$PROJECT_DIR" status --porcelain=v1 --untracked-files=all -- \
  scripts/apply-staging-migrations.sh config/staging-identities.json supabase/migrations 2>/dev/null) || fail
[[ -z "$migration_git_status" ]] || fail

pg_host=$PGHOST
pg_port=$PGPORT
pg_database=$PGDATABASE
pg_user=$PGUSER
pg_password=$PGPASSWORD
pg_sslmode=$PGSSLMODE
pg_ssl_root_cert=${PGSSLROOTCERT:-}
unset PGPASSWORD

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/smoking-zen-staging-migrations.XXXXXXXX") || fail
chmod 700 "$SCRATCH" || fail
migration_snapshot_dir="$SCRATCH/migrations"
mkdir "$migration_snapshot_dir" || fail
chmod 700 "$migration_snapshot_dir" || fail
manifest_file="$SCRATCH/manifest.sha256"
sql_bundle="$SCRATCH/migrations.sql"
psql_result_file="$SCRATCH/psql.result"
provider_log="$SCRATCH/psql.log"
: > "$manifest_file"
: > "$sql_bundle"
: > "$psql_result_file"
: > "$provider_log"
chmod 600 "$manifest_file" "$sql_bundle" "$psql_result_file" "$provider_log" || fail

sha256_file() {
  local file=$1 raw digest
  if [[ "$SHA256_TOOL" == shasum ]]; then
    raw=$(shasum -a 256 "$file" 2>/dev/null) || return 1
  else
    raw=$(sha256sum "$file" 2>/dev/null) || return 1
  fi
  digest=${raw%% *}
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

migration_hashes=()
migration_snapshots=()
for ((index = 0; index < ${#actual_migrations[@]}; index += 1)); do
  migration_snapshot="$migration_snapshot_dir/${expected_migrations[index]}"
  cp "${actual_migrations[index]}" "$migration_snapshot" || fail
  chmod 600 "$migration_snapshot" || fail
  source_hash=$(sha256_file "${actual_migrations[index]}") || fail
  migration_hash=$(sha256_file "$migration_snapshot") || fail
  [[ "$source_hash" == "$migration_hash" ]] || fail
  migration_hashes+=("$migration_hash")
  migration_snapshots+=("$migration_snapshot")
  printf '%s\t%s\n' "${expected_migrations[index]}" "$migration_hash" \
    >> "$manifest_file" || fail
done
manifest_hash=$(sha256_file "$manifest_file") || fail
migration_git_status=$(git -C "$PROJECT_DIR" status --porcelain=v1 --untracked-files=all -- \
  scripts/apply-staging-migrations.sh config/staging-identities.json \
  supabase/migrations 2>/dev/null) || fail
[[ -z "$migration_git_status" ]] || fail

cat >> "$sql_bundle" <<'SQL'
set local lock_timeout = '30s';
set local statement_timeout = '30min';
set local idle_in_transaction_session_timeout = '35min';

create temporary table smoking_zen_migration_run (
  mode text not null check (mode in ('apply', 'reapply')),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  release_commit text not null check (release_commit ~ '^[0-9a-f]{40}$'),
  migration_count integer not null check (migration_count = 19),
  latest_filename text not null
) on commit drop;
SQL
printf "insert into smoking_zen_migration_run values ('%s', '%s', '%s', '%s', 19, '%s');\n" \
  "$STAGING_MIGRATION_MODE" "$STAGING_EXPECTED_SUPABASE_PROJECT_REF" \
  "$manifest_hash" "$STAGING_RELEASE_COMMIT" "${expected_migrations[18]}" \
  >> "$sql_bundle" || fail

cat >> "$sql_bundle" <<'SQL'

do $smoking_zen_migration_lock$
declare
  target_ref text;
begin
  select project_ref into strict target_ref from smoking_zen_migration_run;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('smoking-zen-staging-migrations:' || target_ref, 0)
  );
end
$smoking_zen_migration_lock$;

create schema if not exists private;
revoke create on schema private from public;

create table if not exists private.staging_migration_ledger (
  filename text primary key,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_manifest_sha256 text not null check (applied_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  applied_release_commit text not null check (applied_release_commit ~ '^[0-9a-f]{40}$'),
  applied_at timestamptz not null default clock_timestamp(),
  constraint staging_migration_ledger_filename_check
    check (filename ~ '^[0-9]{4}_[a-z0-9_]+[.]sql$')
);

create table if not exists private.staging_migration_releases (
  release_commit text primary key check (release_commit ~ '^[0-9a-f]{40}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  migration_count integer not null check (migration_count > 0),
  latest_filename text not null,
  verification_mode text not null check (verification_mode in ('apply', 'reapply')),
  verified_at timestamptz not null default clock_timestamp()
);

alter table private.staging_migration_ledger enable row level security;
alter table private.staging_migration_ledger force row level security;
alter table private.staging_migration_releases enable row level security;
alter table private.staging_migration_releases force row level security;
revoke all privileges on table private.staging_migration_ledger
  from public, anon, authenticated, service_role;
revoke all privileges on table private.staging_migration_releases
  from public, anon, authenticated, service_role;

create temporary table smoking_zen_expected_migrations (
  ordinal integer primary key,
  filename text not null unique,
  checksum_sha256 text not null
) on commit drop;

insert into smoking_zen_expected_migrations (ordinal, filename, checksum_sha256) values
SQL
for ((index = 0; index < ${#expected_migrations[@]}; index += 1)); do
  separator=,
  [[ $index -lt $((${#expected_migrations[@]} - 1)) ]] || separator=';'
  printf "  (%d, '%s', '%s')%s\n" "$((index + 1))" \
    "${expected_migrations[index]}" "${migration_hashes[index]}" "$separator" \
    >> "$sql_bundle" || fail
done

cat >> "$sql_bundle" <<'SQL'

do $smoking_zen_ledger_guard$
begin
  if exists (
    select 1
    from private.staging_migration_ledger as ledger
    left join smoking_zen_expected_migrations as expected
      on expected.filename = ledger.filename
    where expected.filename is null
      or ledger.checksum_sha256 is distinct from expected.checksum_sha256
  ) then
    raise exception 'staging migration checksum drift';
  end if;

  if exists (
    select 1
    from smoking_zen_expected_migrations as missing
    where not exists (
      select 1
      from private.staging_migration_ledger as ledger
      where ledger.filename = missing.filename
    )
      and exists (
        select 1
        from private.staging_migration_ledger as later_ledger
        join smoking_zen_expected_migrations as later
          on later.filename = later_ledger.filename
        where later.ordinal > missing.ordinal
      )
  ) then
    raise exception 'staging migration ledger is not an ordered prefix';
  end if;

  if (select mode from smoking_zen_migration_run) = 'reapply'
    and (select count(*) from private.staging_migration_ledger) <> 19
  then
    raise exception 'reapply requires the complete current ledger';
  end if;
end
$smoking_zen_ledger_guard$;
SQL

for ((index = 0; index < ${#actual_migrations[@]}; index += 1)); do
  migration_number=$(printf '%04d' "$((index + 1))")
  if [[ "$STAGING_MIGRATION_MODE" == apply ]]; then
    printf "\nselect not exists (select 1 from private.staging_migration_ledger where filename = '%s') as smoking_zen_apply_%s\n" \
      "${expected_migrations[index]}" "$migration_number" >> "$sql_bundle" || fail
    printf '%s\n' '\gset' "\\if :smoking_zen_apply_$migration_number" >> "$sql_bundle" || fail
  fi

  printf '%s\n' "-- smoking-zen migration: ${expected_migrations[index]}" \
    >> "$sql_bundle" || fail
  cat "${migration_snapshots[index]}" >> "$sql_bundle" || fail
  printf '\n' >> "$sql_bundle" || fail

  if [[ "$STAGING_MIGRATION_MODE" == apply ]]; then
    printf "insert into private.staging_migration_ledger (filename, checksum_sha256, applied_manifest_sha256, applied_release_commit) select '%s', '%s', manifest_sha256, release_commit from smoking_zen_migration_run;\n" \
      "${expected_migrations[index]}" "${migration_hashes[index]}" \
      >> "$sql_bundle" || fail
    printf '%s\n' '\endif' >> "$sql_bundle" || fail
  fi
done

cat >> "$sql_bundle" <<'SQL'

alter table private.staging_migration_ledger enable row level security;
alter table private.staging_migration_ledger force row level security;
alter table private.staging_migration_releases enable row level security;
alter table private.staging_migration_releases force row level security;
revoke all privileges on table private.staging_migration_ledger
  from public, anon, authenticated, service_role;
revoke all privileges on table private.staging_migration_releases
  from public, anon, authenticated, service_role;

insert into private.staging_migration_releases (
  release_commit, manifest_sha256, migration_count, latest_filename, verification_mode
)
select release_commit, manifest_sha256, migration_count, latest_filename, mode
from smoking_zen_migration_run
on conflict (release_commit) do update
set verified_at = clock_timestamp(),
    verification_mode = excluded.verification_mode
where private.staging_migration_releases.manifest_sha256 = excluded.manifest_sha256
  and private.staging_migration_releases.migration_count = excluded.migration_count
  and private.staging_migration_releases.latest_filename = excluded.latest_filename;

do $smoking_zen_postflight$
begin
  if (select count(*) from private.staging_migration_ledger) <> 19 then
    raise exception 'staging migration ledger count mismatch';
  end if;
  if (select max(filename) from private.staging_migration_ledger)
    is distinct from '0019_task8_upload_abuse_guards.sql'
  then
    raise exception 'staging migration latest filename mismatch';
  end if;
SQL
printf "  if (select checksum_sha256 from private.staging_migration_ledger where filename = '0019_task8_upload_abuse_guards.sql') is distinct from '%s' then\n" \
  "${migration_hashes[18]}" >> "$sql_bundle" || fail
cat >> "$sql_bundle" <<'SQL'
    raise exception 'staging migration latest checksum mismatch';
  end if;

  if not exists (
    select 1
    from private.staging_migration_releases as release
    cross join smoking_zen_migration_run as run
    where release.release_commit = run.release_commit
      and release.manifest_sha256 = run.manifest_sha256
      and release.migration_count = run.migration_count
      and release.latest_filename = run.latest_filename
      and release.verification_mode = run.mode
  ) then
    raise exception 'staging migration release receipt mismatch';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname in ('staging_migration_ledger', 'staging_migration_releases')
      and relation.relrowsecurity
      and relation.relforcerowsecurity
    group by namespace.nspname
    having count(*) = 2
  ) then
    raise exception 'staging migration ledger security mismatch';
  end if;

  if exists (
    select 1
    from unnest(array[
      'private.staging_migration_ledger',
      'private.staging_migration_releases'
    ]) as protected_relation(relation_name)
    cross join unnest(array[
      'anon'::pg_catalog.name,
      'authenticated'::pg_catalog.name,
      'service_role'::pg_catalog.name
    ])
      as blocked_role(role_name)
    cross join unnest(array[
      'select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'
    ]) as blocked_privilege(privilege_name)
    where pg_catalog.has_table_privilege(
      blocked_role.role_name,
      protected_relation.relation_name,
      blocked_privilege.privilege_name
    )
  ) then
    raise exception 'staging migration ledger privilege mismatch';
  end if;

  if pg_catalog.to_regprocedure('public.reserve_attachment_upload(uuid,uuid,uuid,uuid,uuid,text,text,bigint,text)') is null
    or pg_catalog.to_regprocedure('public.claim_attachment_validation(uuid,uuid,text)') is null
    or not exists (
      select 1
      from pg_catalog.pg_constraint
      where conrelid = pg_catalog.to_regclass('public.attachments')
        and conname = 'attachments_validation_lease_check'
        and contype = 'c'
        and convalidated
    )
    or (
      select count(*)
      from pg_catalog.pg_attribute
      where attrelid = pg_catalog.to_regclass('public.attachments')
        and attnum > 0
        and not attisdropped
        and (
          (attname = 'validation_lease_id' and atttypid = 'uuid'::pg_catalog.regtype)
          or (
            attname = 'validation_lease_expires_at'
            and atttypid = 'timestamptz'::pg_catalog.regtype
          )
        )
    ) <> 2
    or pg_catalog.to_regclass('public.attachments_upload_workspace_window_idx') is null
  then
    raise exception 'staging migration 0019 schema sentinel mismatch';
  end if;
end
$smoking_zen_postflight$;
SQL
printf "select 'STAGING_MIGRATIONS_OK:%s:%s';\n" "$manifest_hash" \
  "$STAGING_RELEASE_COMMIT" >> "$sql_bundle" || fail
chmod 600 "$manifest_file" "$sql_bundle" "$psql_result_file" "$provider_log" || fail

run_psql() {
  (
    unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE \
      PGSERVICE PGSERVICEFILE PGOPTIONS PGAPPNAME PGCONNECT_TIMEOUT PGCLIENTENCODING \
      PGDATESTYLE PGTZ PGGEQO PGSYSCONFDIR PGLOCALEDIR PGREQUIRESSL PGSSLMODE \
      PGSSLCOMPRESSION PGSSLCERT PGSSLKEY PGSSLROOTCERT PGSSLCRL PGSSLCRLDIR \
      PGSSLSNI PGREQUIREPEER PGCHANNELBINDING PGTARGETSESSIONATTRS PGLOADBALANCEHOSTS \
      PGKRBSRVNAME PGGSSLIB PGREALM PGGSSENCMODE PGSSLMINPROTOCOLVERSION \
      PGSSLMAXPROTOCOLVERSION PGSSLNEGOTIATION PGREQUIREAUTH PG_COLOR
    export PGHOST="$pg_host" PGPORT="$pg_port" PGDATABASE="$pg_database" PGUSER="$pg_user"
    export PGPASSWORD="$pg_password" PGSSLMODE="$pg_sslmode"
    export PGAPPNAME=smoking-zen-staging-migrations PGCONNECT_TIMEOUT=15
    if [[ -n "$pg_ssl_root_cert" ]]; then
      export PGSSLROOTCERT="$pg_ssl_root_cert"
    fi
    command psql -X --no-password --single-transaction --quiet --tuples-only --no-align \
      --set=ON_ERROR_STOP=1 3>&-
  )
}

if run_psql < "$sql_bundle" > "$psql_result_file" 2> "$provider_log"; then
  :
else
  psql_status=$?
  fail "$psql_status"
fi

psql_result=$(tr -d '\r\n' < "$psql_result_file") || fail
expected_result="STAGING_MIGRATIONS_OK:$manifest_hash:$STAGING_RELEASE_COMMIT"
[[ "$psql_result" == "$expected_result" ]] || fail

if [[ "$STAGING_MIGRATION_MODE" == reapply ]]; then
  printf '%s\n' 'Staging migrations reapplied and verified successfully.'
else
  printf '%s\n' 'Staging migrations applied successfully.'
fi
printf 'STAGING_MIGRATION_MANIFEST_SHA256:sha256:%s\n' "$manifest_hash"
