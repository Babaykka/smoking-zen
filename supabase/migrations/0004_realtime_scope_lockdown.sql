-- Browser clients receive a narrowly scoped Realtime bearer. All business data
-- continues to flow through the server-side API and its service-role client.

drop policy if exists app_users_self_select on public.app_users;
drop policy if exists workspaces_member_select on public.workspaces;
drop policy if exists workspaces_owner_update on public.workspaces;
drop policy if exists workspace_members_member_select on public.workspace_members;
drop policy if exists workspace_members_owner_insert on public.workspace_members;
drop policy if exists workspace_members_owner_update on public.workspace_members;
drop policy if exists workspace_members_owner_delete on public.workspace_members;
drop policy if exists invitations_owner_all on public.invitations;
drop policy if exists audit_events_member_select on public.audit_events;
drop policy if exists notification_outbox_owner_select on public.notification_outbox;
drop policy if exists notification_deliveries_member_select on public.notification_deliveries;

do $policies$
declare
  table_name text;
begin
  foreach table_name in array array[
    'task_statuses', 'sections', 'tasks', 'comments', 'knowledge_items', 'contacts',
    'contact_methods', 'secure_items', 'attachments', 'reminders'
  ] loop
    execute format('drop policy if exists %I on public.%I', table_name || '_workspace_member_all', table_name);
  end loop;
end;
$policies$;

revoke all privileges on schema public from public, anon, authenticated;
grant usage on schema public to service_role;
revoke all privileges on all tables in schema public from public, anon, authenticated;
revoke all privileges on all sequences in schema public from public, anon, authenticated;
revoke all privileges on all functions in schema public from public, anon, authenticated;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public revoke all privileges on tables from public, anon, authenticated;
alter default privileges in schema public revoke all privileges on sequences from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public grant all privileges on tables to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

drop policy if exists workspace_files_member_select on storage.objects;
drop policy if exists workspace_files_member_insert on storage.objects;
drop policy if exists workspace_files_member_update on storage.objects;
drop policy if exists workspace_files_member_delete on storage.objects;
revoke all privileges on schema storage from public, anon, authenticated;
revoke all privileges on storage.objects from public, anon, authenticated;
grant usage on schema storage to service_role;
grant all privileges on storage.objects to service_role;

drop policy if exists workspace_broadcast_member_insert on realtime.messages;
drop policy if exists workspace_broadcast_member_select on realtime.messages;
drop policy if exists workspace_broadcast_realtime_select on realtime.messages;
create policy workspace_broadcast_realtime_select on realtime.messages
for select to authenticated
using (
  extension = 'broadcast'
  and auth.jwt() ->> 'smoking_zen_scope' = 'realtime'
  and auth.jwt() ->> 'workspace_id' = private.broadcast_workspace_id(realtime.topic())::text
  and private.is_workspace_member(private.broadcast_workspace_id(realtime.topic()))
);

revoke all privileges on realtime.messages from public, anon, authenticated;
revoke all privileges on schema realtime from public, anon;
grant usage on schema realtime to authenticated, service_role;
grant select on realtime.messages to authenticated;
grant all privileges on realtime.messages to service_role;
