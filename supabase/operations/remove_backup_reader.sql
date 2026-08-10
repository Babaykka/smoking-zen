begin;
drop policy if exists smoking_zen_backup_reader_select on storage.objects;
revoke all privileges on storage.objects from authenticated;
revoke usage on schema storage from authenticated;
commit;
