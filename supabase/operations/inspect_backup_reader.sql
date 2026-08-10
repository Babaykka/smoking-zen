-- Замените единственный NULL на auth.users.id, применённый при настройке.
with configured(reader_id) as (
  values (null::uuid)
)
select
  exists (select 1 from auth.users u where u.id = configured.reader_id) as auth_user_exists,
  not exists (
    select 1 from public.workspace_members member
    where member.user_id = configured.reader_id
  ) as has_no_workspace_membership,
  (select relation.relrowsecurity
   from pg_catalog.pg_class relation
   where relation.oid = 'storage.objects'::regclass) as storage_objects_rls_enabled,
  not exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'storage.objects'::regclass
      and policy.polname <> 'smoking_zen_backup_reader_select'
      and (
        0::oid = any(policy.polroles)
        or (select oid from pg_catalog.pg_roles where rolname = 'authenticated') = any(policy.polroles)
      )
  ) as has_no_other_authenticated_policy,
  has_table_privilege('authenticated', 'storage.objects', 'select') as authenticated_select_granted,
  not has_table_privilege('authenticated', 'storage.objects', 'insert')
    and not has_table_privilege('authenticated', 'storage.objects', 'update')
    and not has_table_privilege('authenticated', 'storage.objects', 'delete')
    and not has_table_privilege('authenticated', 'storage.objects', 'truncate')
    and not has_table_privilege('authenticated', 'storage.objects', 'references')
    and not has_table_privilege('authenticated', 'storage.objects', 'trigger')
    as authenticated_has_no_write_privilege,
  coalesce((
    select policy.polcmd = 'r'
      and policy.polpermissive
      and policy.polroles = array[(select oid from pg_catalog.pg_roles where rolname = 'authenticated')]::oid[]
      and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = format(
        '((bucket_id = %L::text) AND (auth.uid() = %L::uuid))',
        'workspace-files',
        configured.reader_id::text
      )
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'storage'
      and relation.relname = 'objects'
      and policy.polname = 'smoking_zen_backup_reader_select'
  ), false) as select_policy_bound_to_reader
from configured;
