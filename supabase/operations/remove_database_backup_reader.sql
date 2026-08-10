-- Выполните тем же владельцем public/private после остановки backup workflow.
begin;

do $remove$
declare
  application_owner constant name := current_user;
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'smoking_zen_backup_reader') then
    execute format(
      'alter default privileges for role %I in schema public revoke select on tables from smoking_zen_backup_reader',
      application_owner
    );
    execute format(
      'alter default privileges for role %I in schema private revoke select on tables from smoking_zen_backup_reader',
      application_owner
    );
    execute format(
      'alter default privileges for role %I in schema public revoke select on sequences from smoking_zen_backup_reader',
      application_owner
    );
    execute format(
      'alter default privileges for role %I in schema private revoke select on sequences from smoking_zen_backup_reader',
      application_owner
    );
    revoke all privileges on all tables in schema public, private from smoking_zen_backup_reader;
    revoke all privileges on all sequences in schema public, private from smoking_zen_backup_reader;
    revoke usage on schema public, private from smoking_zen_backup_reader;
    execute format(
      'revoke connect on database %I from smoking_zen_backup_reader',
      current_database()
    );
    drop role smoking_zen_backup_reader;
  end if;
end;
$remove$;

commit;
