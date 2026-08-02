-- Task 5: knowledge links and atomic contacts. Browser roles remain locked down by 0004.

alter table public.knowledge_items
  add column if not exists link_url text;

-- Pre-Task-5 link rows had no dedicated URL column. Preserve their title/body as notes
-- rather than inventing or extracting an untrusted URL during the upgrade.
update public.knowledge_items
set kind = 'note'
where kind = 'link' and link_url is null;

alter table public.knowledge_items
  drop constraint if exists knowledge_items_link_url_safe;
alter table public.knowledge_items
  add constraint knowledge_items_link_url_safe check (
    link_url is null or (
      char_length(link_url) <= 2000
      and link_url ~ '^https://'
      and link_url !~ '^https://[^/]*@'
      and link_url !~* '[?&](token|signature|credential|secret|password|x-amz-[^=]+)='
    )
  );
alter table public.knowledge_items
  drop constraint if exists knowledge_items_link_kind_consistent;
alter table public.knowledge_items
  add constraint knowledge_items_link_kind_consistent check (
    (kind = 'link' and link_url is not null) or (kind <> 'link' and link_url is null)
  );

create or replace function private.ensure_workspace_taxonomy(target_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  correct_count integer;
  position_shift integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('smoking-zen-taxonomy:' || target_workspace_id::text, 0));

  select count(*)::integer into correct_count
    from public.task_statuses
    where workspace_id = target_workspace_id and deleted_at is null
      and (name, position) in (values ('Новая', 1), ('В работе', 2), ('Ждёт', 3), ('Готово', 4));
  if correct_count <> 4 then
    select coalesce(max(position), 0) + 100 into position_shift
      from public.task_statuses where workspace_id = target_workspace_id;
    update public.task_statuses set position = position + position_shift
      where workspace_id = target_workspace_id
        and (
          position between 1 and 4
          or name in ('Новая', 'В работе', 'Ждёт', 'Готово')
        );
    insert into public.task_statuses (workspace_id, name, position)
    values
      (target_workspace_id, 'Новая', 1),
      (target_workspace_id, 'В работе', 2),
      (target_workspace_id, 'Ждёт', 3),
      (target_workspace_id, 'Готово', 4)
    on conflict (workspace_id, name) do update set position = excluded.position, deleted_at = null;
  end if;

  select count(*)::integer into correct_count
    from public.sections
    where workspace_id = target_workspace_id and deleted_at is null
      and (name, position) in (values
        ('Открытие', 1),
        ('Ремонт и техника', 2),
        ('Закупки и склад', 3),
        ('Зал и сервис', 4),
        ('Персонал', 5),
        ('Маркетинг', 6),
        ('Документы и финансы', 7),
        ('Безопасность и санитария', 8)
      );
  if correct_count <> 8 then
    select coalesce(max(position), 0) + 100 into position_shift
      from public.sections where workspace_id = target_workspace_id;
    update public.sections set position = position + position_shift
      where workspace_id = target_workspace_id
        and (
          position between 1 and 8
          or name in (
            'Открытие', 'Ремонт и техника', 'Закупки и склад', 'Зал и сервис',
            'Персонал', 'Маркетинг', 'Документы и финансы', 'Безопасность и санитария'
          )
        );
    insert into public.sections (workspace_id, name, position)
    values
      (target_workspace_id, 'Открытие', 1),
      (target_workspace_id, 'Ремонт и техника', 2),
      (target_workspace_id, 'Закупки и склад', 3),
      (target_workspace_id, 'Зал и сервис', 4),
      (target_workspace_id, 'Персонал', 5),
      (target_workspace_id, 'Маркетинг', 6),
      (target_workspace_id, 'Документы и финансы', 7),
      (target_workspace_id, 'Безопасность и санитария', 8)
    on conflict (workspace_id, name) do update set position = excluded.position, deleted_at = null;
  end if;
end;
$$;

revoke all on function private.ensure_workspace_taxonomy(uuid) from public, anon, authenticated, service_role;

do $backfill_taxonomy$
declare workspace_record record;
begin
  for workspace_record in select id from public.workspaces where deleted_at is null loop
    perform private.ensure_workspace_taxonomy(workspace_record.id);
  end loop;
end;
$backfill_taxonomy$;

create or replace function public.bootstrap_telegram_user(
  p_telegram_id text,
  p_first_name text,
  p_last_name text default null,
  p_username text default null,
  p_language_code text default null,
  p_owner_telegram_id text default null,
  p_workspace_name text default 'Smoking Zen'
)
returns table (
  user_id uuid,
  membership_id uuid,
  workspace_id uuid,
  role text,
  active boolean,
  display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_user_id uuid;
  selected_user_deleted_at timestamptz;
  selected_workspace_id uuid;
  selected_membership_id uuid;
  selected_membership_active boolean;
  selected_membership_deleted_at timestamptz;
  selected_workspace_deleted_at timestamptz;
begin
  if p_telegram_id !~ '^[0-9]{1,16}$'
    or p_telegram_id::numeric not between 1 and 4503599627370495
    or p_first_name is null
    or char_length(p_first_name) not between 1 and 256 then
    raise exception 'invalid_telegram_identity' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('smoking-zen-owner-bootstrap', 0));

  insert into public.app_users (telegram_id, first_name, last_name, username, language_code)
  values (p_telegram_id, p_first_name, p_last_name, p_username, p_language_code)
  on conflict (telegram_id) do update set
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    username = excluded.username,
    language_code = excluded.language_code
  where public.app_users.deleted_at is null
  returning id, deleted_at into selected_user_id, selected_user_deleted_at;

  if selected_user_id is null then
    select au.id, au.deleted_at into selected_user_id, selected_user_deleted_at
    from public.app_users au where au.telegram_id = p_telegram_id;
  end if;
  if selected_user_deleted_at is not null then return; end if;

  if p_telegram_id = p_owner_telegram_id then
    select wm.workspace_id, wm.id, wm.active, wm.deleted_at, w.deleted_at
      into selected_workspace_id, selected_membership_id, selected_membership_active,
        selected_membership_deleted_at, selected_workspace_deleted_at
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = selected_user_id and wm.role = 'owner'
    order by wm.created_at
    limit 1;

    if selected_workspace_id is null then
      insert into public.workspaces (name) values (p_workspace_name)
      returning id into selected_workspace_id;
      insert into public.workspace_members (workspace_id, user_id, display_name, role, active)
      values (selected_workspace_id, selected_user_id, trim(concat_ws(' ', p_first_name, p_last_name)), 'owner', true)
      returning id into selected_membership_id;
    elsif not selected_membership_active
      or selected_membership_deleted_at is not null
      or selected_workspace_deleted_at is not null then
      return;
    end if;
    perform private.ensure_workspace_taxonomy(selected_workspace_id);
  end if;

  return query
  select au.id, wm.id, wm.workspace_id, wm.role, wm.active and wm.deleted_at is null, wm.display_name
  from public.app_users au
  join public.workspace_members wm on wm.user_id = au.id
  join public.workspaces w on w.id = wm.workspace_id
  where au.id = selected_user_id
    and au.deleted_at is null
    and wm.active
    and wm.deleted_at is null
    and w.deleted_at is null
  order by (wm.role = 'owner') desc, wm.created_at
  limit 1;
end;
$$;

revoke all on function public.bootstrap_telegram_user(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_telegram_user(text, text, text, text, text, text, text)
  to service_role;

alter table public.contacts drop constraint if exists contacts_category_check;
update public.contacts set category = 'service' where category = 'contractor';
update public.contacts set category = 'landlord' where category = 'partner';
alter table public.contacts
  add constraint contacts_category_check check (category in ('supplier', 'service', 'landlord', 'cleaning', 'other'));

alter table public.contact_methods drop constraint if exists contact_methods_contact_id_position_key;
create unique index if not exists contact_methods_live_position_idx
  on public.contact_methods (contact_id, position) where deleted_at is null;

create or replace function public.create_contact_with_methods(
  p_workspace_id uuid,
  p_name text,
  p_category text,
  p_notes text,
  p_methods jsonb
)
returns setof public.contacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  method jsonb;
  item public.contacts%rowtype;
  method_position integer := 0;
begin
  if p_methods is null or jsonb_typeof(p_methods) <> 'array' or jsonb_array_length(p_methods) not between 1 and 10
    or p_name is null or char_length(trim(p_name)) not between 1 and 280
    or p_category not in ('supplier', 'service', 'landlord', 'cleaning', 'other')
    or p_notes is null or char_length(p_notes) > 10000 then
    raise exception 'invalid_contact' using errcode = '22023';
  end if;

  insert into public.contacts (workspace_id, name, category, notes)
    values (p_workspace_id, trim(p_name), p_category, trim(p_notes))
    returning * into item;
  for method in select value from jsonb_array_elements(p_methods) loop
    method_position := method_position + 1;
    if method ->> 'kind' not in ('phone', 'telegram', 'whatsapp')
      or coalesce(char_length(method ->> 'value'), 0) not between 1 and 300 then
      raise exception 'invalid_contact_method' using errcode = '22023';
    end if;
    insert into public.contact_methods (workspace_id, contact_id, kind, value, position)
      values (p_workspace_id, item.id, method ->> 'kind', method ->> 'value', method_position);
  end loop;
  return next item;
end;
$$;

revoke all on function public.create_contact_with_methods(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_contact_with_methods(uuid, text, text, text, jsonb) to service_role;

create or replace function public.replace_contact_with_methods(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_expected_version integer,
  p_name text,
  p_category text,
  p_notes text,
  p_methods jsonb
)
returns setof public.contacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  method jsonb;
  item public.contacts%rowtype;
  method_position integer := 0;
begin
  if p_methods is null or jsonb_typeof(p_methods) <> 'array' or jsonb_array_length(p_methods) not between 1 and 10
    or p_name is null or char_length(trim(p_name)) not between 1 and 280
    or p_category not in ('supplier', 'service', 'landlord', 'cleaning', 'other')
    or p_notes is null or char_length(p_notes) > 10000 then
    raise exception 'invalid_contact' using errcode = '22023';
  end if;

  select * into item from public.contacts
    where id = p_contact_id and workspace_id = p_workspace_id and deleted_at is null for update;
  if not found then raise exception 'contact_not_found' using errcode = 'P0002'; end if;
  if item.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;

  -- Existing metadata triggers increment version/updated_at for both parent and methods.
  update public.contacts set name = trim(p_name), category = p_category, notes = trim(p_notes)
    where id = p_contact_id and workspace_id = p_workspace_id;
  update public.contact_methods set deleted_at = clock_timestamp()
    where workspace_id = p_workspace_id and contact_id = p_contact_id and deleted_at is null;

  for method in select value from jsonb_array_elements(p_methods) loop
    method_position := method_position + 1;
    if method ->> 'kind' not in ('phone', 'telegram', 'whatsapp')
      or coalesce(char_length(method ->> 'value'), 0) not between 1 and 300 then
      raise exception 'invalid_contact_method' using errcode = '22023';
    end if;
    insert into public.contact_methods (workspace_id, contact_id, kind, value, position)
      values (p_workspace_id, p_contact_id, method ->> 'kind', method ->> 'value', method_position);
  end loop;
  return query select * from public.contacts where id = p_contact_id and workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.replace_contact_with_methods(uuid, uuid, integer, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_contact_with_methods(uuid, uuid, integer, text, text, text, jsonb) to service_role;

create or replace function public.set_contact_deleted(
  p_workspace_id uuid,
  p_contact_id uuid,
  p_expected_version integer,
  p_restore boolean default false
)
returns setof public.contacts
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.contacts%rowtype;
  operation_time timestamptz := clock_timestamp();
begin
  select * into item from public.contacts where id = p_contact_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'contact_not_found' using errcode = 'P0002'; end if;
  if item.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if p_restore then
    if item.deleted_at is null then
      raise exception 'restore_not_deleted' using errcode = '55000';
    end if;
    if item.deleted_at + interval '30 days' <= clock_timestamp() then
      raise exception 'restore_expired' using errcode = '22023';
    end if;
    update public.contacts set deleted_at = null where id = p_contact_id and workspace_id = p_workspace_id;
    -- Only restore the methods archived with this deletion. Older replaced methods stay archived.
    update public.contact_methods set deleted_at = null
      where workspace_id = p_workspace_id and contact_id = p_contact_id and deleted_at = item.deleted_at;
  else
    if item.deleted_at is not null then raise exception 'contact_not_found' using errcode = 'P0002'; end if;
    update public.contacts set deleted_at = operation_time where id = p_contact_id and workspace_id = p_workspace_id;
    update public.contact_methods set deleted_at = operation_time where workspace_id = p_workspace_id and contact_id = p_contact_id and deleted_at is null;
  end if;
  return query select * from public.contacts where id = p_contact_id and workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.set_contact_deleted(uuid, uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.set_contact_deleted(uuid, uuid, integer, boolean) to service_role;

create or replace function public.restore_task_record(
  p_workspace_id uuid,
  p_task_id uuid,
  p_expected_version integer
)
returns setof public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.tasks%rowtype;
begin
  select * into item from public.tasks
    where id = p_task_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'task_not_found' using errcode = 'P0002'; end if;
  if item.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
  if item.deleted_at + interval '30 days' <= clock_timestamp() then
    raise exception 'restore_expired' using errcode = '22023';
  end if;

  update public.tasks set deleted_at = null
    where id = p_task_id and workspace_id = p_workspace_id;
  return query select * from public.tasks where id = p_task_id and workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.restore_task_record(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.restore_task_record(uuid, uuid, integer) to service_role;

create or replace function public.restore_knowledge_record(
  p_workspace_id uuid,
  p_knowledge_id uuid,
  p_expected_version integer
)
returns setof public.knowledge_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.knowledge_items%rowtype;
begin
  select * into item from public.knowledge_items
    where id = p_knowledge_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'knowledge_not_found' using errcode = 'P0002'; end if;
  if item.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
  if item.deleted_at + interval '30 days' <= clock_timestamp() then
    raise exception 'restore_expired' using errcode = '22023';
  end if;

  update public.knowledge_items set deleted_at = null
    where id = p_knowledge_id and workspace_id = p_workspace_id;
  return query select * from public.knowledge_items where id = p_knowledge_id and workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.restore_knowledge_record(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.restore_knowledge_record(uuid, uuid, integer) to service_role;

create or replace function public.search_workspace(
  p_workspace_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table(entity text, id uuid, title text)
language sql
stable
security definer
set search_path = ''
as $$
  select entity, id, title from (
    select 'task'::text as entity, t.id, t.title, t.updated_at
      from public.tasks t
      where t.workspace_id = p_workspace_id and t.deleted_at is null
        and (position(lower(trim(p_query)) in lower(t.title)) > 0
          or position(lower(trim(p_query)) in lower(t.description)) > 0)
    union all
    select 'knowledge'::text, k.id, k.title, k.updated_at
      from public.knowledge_items k
      where k.workspace_id = p_workspace_id and k.deleted_at is null
        and (position(lower(trim(p_query)) in lower(k.title)) > 0
          or position(lower(trim(p_query)) in lower(k.body)) > 0)
    union all
    select 'contact'::text, c.id, c.name, c.updated_at
      from public.contacts c
      where c.workspace_id = p_workspace_id and c.deleted_at is null
        and (position(lower(trim(p_query)) in lower(c.name)) > 0
          or position(lower(trim(p_query)) in lower(c.notes)) > 0)
  ) results
  where char_length(trim(p_query)) between 1 and 120
  order by updated_at desc,
    case entity when 'task' then 0 when 'knowledge' then 1 else 2 end,
    id
  limit greatest(1, least(coalesce(p_limit, 20), 20));
$$;

revoke all on function public.search_workspace(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.search_workspace(uuid, text, integer) to service_role;

create or replace function private.broadcast_workspace_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_action text;
  event_entity text;
begin
  event_entity := case tg_table_name
    when 'tasks' then 'task'
    when 'comments' then 'comment'
    when 'knowledge_items' then 'knowledge'
    when 'contacts' then 'contact'
    when 'contact_methods' then 'contact_method'
  end;
  event_action := case when tg_op = 'INSERT' then 'created'
    when old.deleted_at is null and new.deleted_at is not null then 'deleted'
    when old.deleted_at is not null and new.deleted_at is null then 'restored' else 'updated' end;
  perform realtime.send(jsonb_build_object('entity', event_entity, 'action', event_action), 'workspace_changed', 'workspace:' || new.workspace_id::text, true);
  return new;
end;
$$;

do $triggers$
declare table_name text;
begin
  foreach table_name in array array['knowledge_items', 'contacts', 'contact_methods'] loop
    execute format('drop trigger if exists broadcast_workspace_change on public.%I', table_name);
    execute format('create trigger broadcast_workspace_change after insert or update on public.%I for each row execute function private.broadcast_workspace_change()', table_name);
  end loop;
end;
$triggers$;
