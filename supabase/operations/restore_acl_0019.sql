begin;

-- Privilege/RLS companion for backup manifest schemaRevision 0019.
-- It deliberately contains no application-data statements or function bodies.

revoke all privileges on schema public from public, anon, authenticated, service_role;
grant usage on schema public to service_role;
revoke all privileges on all tables in schema public from public, anon, authenticated, service_role;
revoke all privileges on all sequences in schema public from public, anon, authenticated, service_role;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public revoke all privileges on tables from public, anon, authenticated;
alter default privileges in schema public revoke all privileges on sequences from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public grant all privileges on tables to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

revoke all privileges on public.audit_events from service_role;
grant select on public.audit_events to service_role;

revoke all privileges on schema private from public, anon, authenticated, service_role;
grant usage on schema private to authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function private.is_workspace_owner(uuid) to authenticated, service_role;
grant execute on function private.storage_workspace_id(text) to authenticated, service_role;
grant execute on function private.broadcast_workspace_id(text) to authenticated, service_role;
grant execute on function private.knowledge_url_is_safe(text) to service_role;
grant execute on function private.secure_item_normalize(text) to service_role;
grant execute on function private.percent_decode_url_component(text) to service_role;
grant execute on function private.persisted_text_is_safe(text) to service_role;
grant execute on function private.secure_item_scan_text(text) to service_role;
grant execute on function private.secure_item_text_is_safe(text) to service_role;
grant execute on function private.secure_item_url_is_safe(text) to service_role;
grant execute on function private.ensure_quarantine_cleanup_guard(uuid, uuid, text, timestamptz)
  to service_role;

drop policy if exists workspace_files_member_select on storage.objects;
drop policy if exists workspace_files_member_insert on storage.objects;
drop policy if exists workspace_files_member_update on storage.objects;
drop policy if exists workspace_files_member_delete on storage.objects;
revoke all privileges on schema storage from public, anon, authenticated, service_role;
revoke all privileges on storage.objects from public, anon, authenticated, service_role;
alter table storage.objects enable row level security;
grant usage on schema storage to service_role;
grant all privileges on storage.objects to service_role;

drop policy if exists workspace_broadcast_member_insert on realtime.messages;
drop policy if exists workspace_broadcast_member_select on realtime.messages;
drop policy if exists workspace_broadcast_realtime_select on realtime.messages;
alter table realtime.messages enable row level security;
create policy workspace_broadcast_realtime_select on realtime.messages
for select to authenticated
using (
  extension = 'broadcast'
  and auth.jwt() ->> 'smoking_zen_scope' = 'realtime'
  and auth.jwt() ->> 'workspace_id' = private.broadcast_workspace_id(realtime.topic())::text
  and private.is_workspace_member(private.broadcast_workspace_id(realtime.topic()))
);

revoke all privileges on schema realtime from public, anon, authenticated, service_role;
revoke all privileges on realtime.messages from public, anon, authenticated, service_role;
grant usage on schema realtime to authenticated, service_role;
grant select on realtime.messages to authenticated;
grant all privileges on realtime.messages to service_role;

commit;
