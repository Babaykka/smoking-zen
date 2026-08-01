create schema if not exists private;

create or replace function private.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    join public.app_users au on au.id = wm.user_id
    join public.workspaces w on w.id = wm.workspace_id
    where wm.workspace_id = target_workspace_id
      and wm.user_id = auth.uid()
      and wm.active
      and wm.deleted_at is null
      and au.deleted_at is null
      and w.deleted_at is null
  )
$$;

create or replace function private.is_workspace_owner(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = 'owner'
      and wm.active
      and wm.deleted_at is null
  )
$$;

create or replace function private.storage_workspace_id(object_name text)
returns uuid
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  first_segment text := split_part(object_name, '/', 1);
begin
  if first_segment ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return first_segment::uuid;
  end if;
  return null;
end;
$$;

create or replace function private.broadcast_workspace_id(topic_name text)
returns uuid
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  workspace_text text;
begin
  if topic_name !~* '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  workspace_text := split_part(topic_name, ':', 2);
  return workspace_text::uuid;
end;
$$;

revoke all on function private.is_workspace_member(uuid) from public;
revoke all on function private.is_workspace_owner(uuid) from public;
revoke all on function private.storage_workspace_id(text) from public;
revoke all on function private.broadcast_workspace_id(text) from public;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function private.is_workspace_owner(uuid) to authenticated, service_role;
grant execute on function private.storage_workspace_id(text) to authenticated, service_role;
grant execute on function private.broadcast_workspace_id(text) to authenticated, service_role;

alter table public.app_users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.task_statuses enable row level security;
alter table public.sections enable row level security;
alter table public.tasks enable row level security;
alter table public.comments enable row level security;
alter table public.knowledge_items enable row level security;
alter table public.contacts enable row level security;
alter table public.contact_methods enable row level security;
alter table public.secure_items enable row level security;
alter table public.attachments enable row level security;
alter table public.invitations enable row level security;
alter table public.reminders enable row level security;
alter table public.audit_events enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.notification_deliveries enable row level security;

drop policy if exists app_users_self_select on public.app_users;
create policy app_users_self_select on public.app_users for select to authenticated
using (id = auth.uid() and deleted_at is null);
drop policy if exists app_users_self_update on public.app_users;
create policy app_users_self_update on public.app_users for update to authenticated
using (id = auth.uid() and deleted_at is null)
with check (id = auth.uid() and deleted_at is null);

drop policy if exists workspaces_member_select on public.workspaces;
create policy workspaces_member_select on public.workspaces for select to authenticated
using (private.is_workspace_member(id) and deleted_at is null);
drop policy if exists workspaces_owner_update on public.workspaces;
create policy workspaces_owner_update on public.workspaces for update to authenticated
using (private.is_workspace_owner(id) and deleted_at is null)
with check (private.is_workspace_owner(id));

drop policy if exists workspace_members_member_select on public.workspace_members;
create policy workspace_members_member_select on public.workspace_members for select to authenticated
using (private.is_workspace_member(workspace_id));
drop policy if exists workspace_members_owner_insert on public.workspace_members;
create policy workspace_members_owner_insert on public.workspace_members for insert to authenticated
with check (private.is_workspace_owner(workspace_id));
drop policy if exists workspace_members_owner_update on public.workspace_members;
create policy workspace_members_owner_update on public.workspace_members for update to authenticated
using (private.is_workspace_owner(workspace_id))
with check (private.is_workspace_owner(workspace_id));
drop policy if exists workspace_members_owner_delete on public.workspace_members;
create policy workspace_members_owner_delete on public.workspace_members for delete to authenticated
using (private.is_workspace_owner(workspace_id));

do $policies$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'task_statuses', 'sections', 'tasks', 'comments', 'knowledge_items', 'contacts',
    'contact_methods', 'secure_items', 'attachments', 'reminders'
  ] loop
    policy_name := table_name || '_workspace_member_all';
    execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using (private.is_workspace_member(workspace_id)) with check (private.is_workspace_member(workspace_id))',
      policy_name,
      table_name
    );
  end loop;
end;
$policies$;

drop policy if exists invitations_owner_all on public.invitations;
create policy invitations_owner_all on public.invitations for all to authenticated
using (private.is_workspace_owner(workspace_id))
with check (private.is_workspace_owner(workspace_id));

drop policy if exists audit_events_member_select on public.audit_events;
create policy audit_events_member_select on public.audit_events for select to authenticated
using (private.is_workspace_member(workspace_id));

drop policy if exists notification_outbox_owner_select on public.notification_outbox;
create policy notification_outbox_owner_select on public.notification_outbox for select to authenticated
using (private.is_workspace_owner(workspace_id));

drop policy if exists notification_deliveries_member_select on public.notification_deliveries;
create policy notification_deliveries_member_select on public.notification_deliveries for select to authenticated
using (private.is_workspace_member(workspace_id));

insert into storage.buckets (id, name, public, file_size_limit)
values ('workspace-files', 'workspace-files', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists workspace_files_member_select on storage.objects;
create policy workspace_files_member_select on storage.objects for select to authenticated
using (
  bucket_id = 'workspace-files'
  and private.is_workspace_member(private.storage_workspace_id(name))
);
drop policy if exists workspace_files_member_insert on storage.objects;
create policy workspace_files_member_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'workspace-files'
  and private.is_workspace_member(private.storage_workspace_id(name))
);
drop policy if exists workspace_files_member_update on storage.objects;
create policy workspace_files_member_update on storage.objects for update to authenticated
using (
  bucket_id = 'workspace-files'
  and private.is_workspace_member(private.storage_workspace_id(name))
)
with check (
  bucket_id = 'workspace-files'
  and private.is_workspace_member(private.storage_workspace_id(name))
);
drop policy if exists workspace_files_member_delete on storage.objects;
create policy workspace_files_member_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'workspace-files'
  and private.is_workspace_member(private.storage_workspace_id(name))
);

alter table realtime.messages enable row level security;
drop policy if exists workspace_broadcast_member_select on realtime.messages;
create policy workspace_broadcast_member_select on realtime.messages for select to authenticated
using (
  extension = 'broadcast'
  and private.is_workspace_member(private.broadcast_workspace_id(realtime.topic()))
);
drop policy if exists workspace_broadcast_member_insert on realtime.messages;
create policy workspace_broadcast_member_insert on realtime.messages for insert to authenticated
with check (
  extension = 'broadcast'
  and private.is_workspace_member(private.broadcast_workspace_id(realtime.topic()))
);
