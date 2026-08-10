with role_state as (
  select oid, rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
    rolcreaterole, rolreplication, rolbypassrls, rolconfig
  from pg_catalog.pg_roles
  where rolname = 'smoking_zen_backup_reader'
), default_select as (
  select count(*) as rule_count
  from pg_catalog.pg_default_acl defaults
  cross join lateral aclexplode(coalesce(defaults.defaclacl, acldefault(defaults.defaclobjtype, defaults.defaclrole))) access
  join role_state on access.grantee = role_state.oid
  join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
  where namespace.nspname in ('public', 'private')
    and defaults.defaclobjtype in ('r', 'S')
    and access.privilege_type = 'SELECT'
), direct_acl_risk as (
  select exists (
    select 1
    from (
      select namespace.nspname, access.privilege_type
      from pg_catalog.pg_namespace namespace
      cross join lateral aclexplode(namespace.nspacl) access
      join role_state on role_state.oid = access.grantee
      where not (namespace.nspname in ('public', 'private') and access.privilege_type = 'USAGE')
      union all
      select namespace.nspname, access.privilege_type
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      cross join lateral aclexplode(relation.relacl) access
      join role_state on role_state.oid = access.grantee
      where not (namespace.nspname in ('public', 'private') and access.privilege_type = 'SELECT')
      union all
      select namespace.nspname, access.privilege_type
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      cross join lateral aclexplode(routine.proacl) access
      join role_state on role_state.oid = access.grantee
      union all
      select database.datname, access.privilege_type
      from pg_catalog.pg_database database
      cross join lateral aclexplode(database.datacl) access
      join role_state on role_state.oid = access.grantee
      where not (database.datname = current_database() and access.privilege_type = 'CONNECT')
      union all
      select coalesce(namespace.nspname, ''), access.privilege_type
      from pg_catalog.pg_default_acl defaults
      left join pg_catalog.pg_namespace namespace on namespace.oid = defaults.defaclnamespace
      cross join lateral aclexplode(defaults.defaclacl) access
      join role_state on role_state.oid = access.grantee
      where not (namespace.nspname in ('public', 'private')
        and defaults.defaclobjtype in ('r', 'S') and access.privilege_type = 'SELECT')
    ) unexpected_acl
  ) as found
), privilege_risk as (
  select
    exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'private') and relation.relkind in ('r', 'p')
        and not has_table_privilege('smoking_zen_backup_reader', relation.oid, 'select')
    ) as missing_table_select,
    exists (
      select 1 from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'private') and relation.relkind in ('r', 'p')
        and (has_table_privilege('smoking_zen_backup_reader', relation.oid, 'insert')
          or has_table_privilege('smoking_zen_backup_reader', relation.oid, 'update')
          or has_table_privilege('smoking_zen_backup_reader', relation.oid, 'delete')
          or has_table_privilege('smoking_zen_backup_reader', relation.oid, 'truncate')
          or has_table_privilege('smoking_zen_backup_reader', relation.oid, 'references')
          or has_table_privilege('smoking_zen_backup_reader', relation.oid, 'trigger'))
    ) as has_write_privilege,
    exists (
      select 1 from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname in ('public', 'private') and routine.prosecdef
        and has_function_privilege('smoking_zen_backup_reader', routine.oid, 'execute')
    ) as executable_security_definer,
    exists (
      select 1 from pg_catalog.pg_auth_members membership
      join role_state on role_state.oid in (membership.roleid, membership.member)
    ) as has_role_membership
)
select
  role_state.rolcanlogin,
  not role_state.rolinherit as noinherit,
  not role_state.rolsuper as nosuperuser,
  not role_state.rolcreatedb as nocreatedb,
  not role_state.rolcreaterole as nocreaterole,
  not role_state.rolreplication as noreplication,
  role_state.rolbypassrls,
  role_state.rolconfig @> array['default_transaction_read_only=on'] as transaction_read_only,
  role_state.rolconfig @> array['statement_timeout=55min'] as statement_timeout_bounded,
  role_state.rolconfig @> array['idle_in_transaction_session_timeout=55min'] as idle_transaction_timeout_bounded,
  role_state.rolconfig @> array['idle_session_timeout=55min'] as idle_session_timeout_bounded,
  has_database_privilege(role_state.rolname, current_database(), 'connect') as can_connect,
  has_schema_privilege(role_state.rolname, 'public', 'usage') as public_usage,
  has_schema_privilege(role_state.rolname, 'private', 'usage') as private_usage,
  default_select.rule_count >= 4 as has_select_acldefault,
  not privilege_risk.missing_table_select as current_table_select_covered,
  not privilege_risk.has_write_privilege as no_write_privilege,
  not privilege_risk.executable_security_definer as no_executable_security_definer,
  not privilege_risk.has_role_membership as no_role_membership,
  not direct_acl_risk.found as no_unexpected_direct_acl
from role_state, default_select, privilege_risk, direct_acl_risk;
