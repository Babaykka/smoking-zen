-- Выполните владельцем public/private. Пароль задаётся отдельно интерактивной \password.
begin;

do $configure$
declare
  application_owner constant name := current_user;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'smoking_zen_backup_reader') then
    execute 'create role smoking_zen_backup_reader';
  end if;

  if exists (
    select 1 from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles role on role.oid in (membership.roleid, membership.member)
    where role.rolname = 'smoking_zen_backup_reader'
  ) then
    raise exception 'smoking_zen_backup_reader_unexpected_membership';
  end if;

  execute 'alter role smoking_zen_backup_reader login noinherit nosuperuser nocreatedb nocreaterole noreplication bypassrls';
  execute 'alter role smoking_zen_backup_reader set default_transaction_read_only = on';
  execute 'alter role smoking_zen_backup_reader set statement_timeout = ''55min''';
  execute 'alter role smoking_zen_backup_reader set idle_in_transaction_session_timeout = ''55min''';
  execute 'alter role smoking_zen_backup_reader set idle_session_timeout = ''55min''';

  execute format(
    'grant connect on database %I to smoking_zen_backup_reader',
    current_database()
  );
  grant usage on schema public, private to smoking_zen_backup_reader;
  grant select on all tables in schema public, private to smoking_zen_backup_reader;
  grant select on all sequences in schema public, private to smoking_zen_backup_reader;
  revoke insert, update, delete, truncate, references, trigger
    on all tables in schema public, private from smoking_zen_backup_reader;
  revoke usage, update on all sequences in schema public, private from smoking_zen_backup_reader;

  execute format(
    'alter default privileges for role %I in schema public grant select on tables to smoking_zen_backup_reader',
    application_owner
  );
  execute format(
    'alter default privileges for role %I in schema private grant select on tables to smoking_zen_backup_reader',
    application_owner
  );
  execute format(
    'alter default privileges for role %I in schema public grant select on sequences to smoking_zen_backup_reader',
    application_owner
  );
  execute format(
    'alter default privileges for role %I in schema private grant select on sequences to smoking_zen_backup_reader',
    application_owner
  );

  if exists (
    select 1
    from (
      select namespace.nspname, access.privilege_type
      from pg_catalog.pg_namespace namespace
      cross join lateral aclexplode(namespace.nspacl) access
      where access.grantee = (select oid from pg_catalog.pg_roles where rolname = 'smoking_zen_backup_reader')
        and not (namespace.nspname in ('public', 'private') and access.privilege_type = 'USAGE')
      union all
      select namespace.nspname, access.privilege_type
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral aclexplode(relation.relacl) access
      where access.grantee = (select oid from pg_catalog.pg_roles where rolname = 'smoking_zen_backup_reader')
        and not (namespace.nspname in ('public', 'private') and access.privilege_type = 'SELECT')
      union all
      select namespace.nspname, access.privilege_type
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      cross join lateral aclexplode(routine.proacl) access
      where access.grantee = (select oid from pg_catalog.pg_roles where rolname = 'smoking_zen_backup_reader')
      union all
      select database.datname, access.privilege_type
      from pg_catalog.pg_database database
      cross join lateral aclexplode(database.datacl) access
      where access.grantee = (select oid from pg_catalog.pg_roles where rolname = 'smoking_zen_backup_reader')
        and not (database.datname = current_database() and access.privilege_type = 'CONNECT')
      union all
      select coalesce(namespace.nspname, ''), access.privilege_type
      from pg_catalog.pg_default_acl defaults
      left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
      cross join lateral aclexplode(defaults.defaclacl) access
      where access.grantee = (select oid from pg_catalog.pg_roles where rolname = 'smoking_zen_backup_reader')
        and not (namespace.nspname in ('public', 'private')
          and defaults.defaclobjtype in ('r', 'S') and access.privilege_type = 'SELECT')
    ) unexpected_acl
  ) then
    raise exception 'smoking_zen_backup_reader_unexpected_direct_acl';
  end if;

  if exists (
    select 1 from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname in ('public', 'private')
      and routine.prosecdef
      and has_function_privilege('smoking_zen_backup_reader', routine.oid, 'execute')
  ) then
    raise exception 'smoking_zen_backup_reader_security_definer_execute';
  end if;

  if exists (
    select 1 from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname in ('public', 'private') and relation.relkind in ('r', 'p')
      and not has_table_privilege('smoking_zen_backup_reader', relation.oid, 'select')
  ) then
    raise exception 'smoking_zen_backup_reader_select_coverage_incomplete';
  end if;
end;
$configure$;

commit;
