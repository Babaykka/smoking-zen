-- Замените единственный NULL ниже на auth.users.id отдельного backup-reader пользователя.
-- NULL намеренно останавливает выполнение без изменений.
begin;

do $guard$
declare
  reader_id constant uuid := null;
begin
  if reader_id is null then
    raise exception 'smoking_zen_backup_reader_uuid_not_configured';
  end if;
  if not exists (select 1 from auth.users where id = reader_id) then
    raise exception 'smoking_zen_backup_reader_auth_user_missing';
  end if;
  if exists (select 1 from public.workspace_members where user_id = reader_id) then
    raise exception 'smoking_zen_backup_reader_must_not_be_workspace_member';
  end if;
  if exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'storage.objects'::regclass
      and policy.polname <> 'smoking_zen_backup_reader_select'
      and (
        0::oid = any(policy.polroles)
        or (select oid from pg_catalog.pg_roles where rolname = 'authenticated') = any(policy.polroles)
      )
  ) then
    raise exception 'smoking_zen_backup_reader_unexpected_storage_policy';
  end if;

  execute 'alter table storage.objects enable row level security';
  execute 'drop policy if exists smoking_zen_backup_reader_select on storage.objects';
  execute format(
    'create policy smoking_zen_backup_reader_select on storage.objects for select to authenticated using (bucket_id = %L and auth.uid() = %L::uuid)',
    'workspace-files',
    reader_id::text
  );
end;
$guard$;

grant usage on schema storage to authenticated;
grant select on storage.objects to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on storage.objects from authenticated;

commit;
