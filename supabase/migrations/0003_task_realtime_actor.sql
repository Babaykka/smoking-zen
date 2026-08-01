create schema if not exists private;

create or replace function private.request_audit_actor(target_workspace_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  request_headers jsonb;
  actor_text text;
  actor_id uuid;
begin
  begin
    request_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    return null;
  end;

  actor_text := request_headers ->> 'x-smoking-zen-actor';
  if actor_text is null
    or actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  actor_id := actor_text::uuid;

  if exists (
    select 1
    from public.workspace_members wm
    join public.app_users au on au.id = wm.user_id
    join public.workspaces w on w.id = wm.workspace_id
    where wm.workspace_id = target_workspace_id
      and wm.user_id = actor_id
      and wm.active
      and wm.deleted_at is null
      and au.deleted_at is null
      and w.deleted_at is null
  ) then
    return actor_id;
  end if;
  return null;
end;
$$;

revoke all on function private.request_audit_actor(uuid) from public, anon, authenticated, service_role;

create or replace function private.audit_workspace_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_action text;
  event_entity text;
  created_event_id uuid;
begin
  event_entity := case tg_table_name
    when 'tasks' then 'task'
    when 'comments' then 'comment'
    when 'knowledge_items' then 'knowledge'
    when 'contacts' then 'contact'
    when 'secure_items' then 'secure_item'
  end;
  event_action := case
    when tg_op = 'INSERT' then 'created'
    when old.deleted_at is null and new.deleted_at is not null then 'deleted'
    when old.deleted_at is not null and new.deleted_at is null then 'restored'
    else 'updated'
  end;

  insert into public.audit_events (
    workspace_id, entity_type, entity_id, action, actor_user_id, entity_version
  ) values (
    new.workspace_id,
    event_entity,
    new.id,
    event_action,
    coalesce(auth.uid(), private.request_audit_actor(new.workspace_id)),
    new.version
  ) returning id into created_event_id;

  if event_entity in ('task', 'comment') then
    insert into public.notification_outbox (workspace_id, event_id, channel, payload)
    values (
      new.workspace_id,
      created_event_id,
      'telegram',
      jsonb_build_object('entity', event_entity, 'entityId', new.id, 'action', event_action)
    )
    on conflict (event_id, channel) do nothing;
  end if;
  return new;
end;
$$;
