-- Task 5: knowledge links and atomic contacts. Browser roles remain locked down by 0004.

alter table public.knowledge_items
  add column if not exists link_url text;

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
  if jsonb_typeof(p_methods) <> 'array' or jsonb_array_length(p_methods) not between 1 and 10
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
  if jsonb_typeof(p_methods) <> 'array' or jsonb_array_length(p_methods) not between 1 and 10
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
    if item.deleted_at is null or item.deleted_at + interval '30 days' <= clock_timestamp() then
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
        and (t.title ilike '%' || trim(p_query) || '%' or t.description ilike '%' || trim(p_query) || '%')
    union all
    select 'knowledge'::text, k.id, k.title, k.updated_at
      from public.knowledge_items k
      where k.workspace_id = p_workspace_id and k.deleted_at is null
        and (k.title ilike '%' || trim(p_query) || '%' or k.body ilike '%' || trim(p_query) || '%')
    union all
    select 'contact'::text, c.id, c.name, c.updated_at
      from public.contacts c
      where c.workspace_id = p_workspace_id and c.deleted_at is null
        and (c.name ilike '%' || trim(p_query) || '%' or c.notes ilike '%' || trim(p_query) || '%')
  ) results
  where char_length(trim(p_query)) between 1 and 120
  order by updated_at desc
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
