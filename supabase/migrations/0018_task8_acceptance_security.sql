-- Task 8 acceptance hardening: versioned attachment recovery, private grants,
-- and append-only attachment history without Storage coordinates.

alter table public.audit_events
  drop constraint if exists audit_events_entity_type_check;
alter table public.audit_events
  add constraint audit_events_entity_type_check check (
    entity_type in ('task', 'comment', 'knowledge', 'contact', 'secure_item', 'attachment')
  );

create or replace function private.audit_attachment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_action text;
begin
  event_action := case
    when tg_op = 'INSERT' then 'created'
    when old.deleted_at is null and new.deleted_at is not null then 'deleted'
    when old.deleted_at is not null and new.deleted_at is null then 'restored'
    else 'updated'
  end;

  insert into public.audit_events (
    workspace_id, entity_type, entity_id, action, actor_user_id, entity_version
  ) values (
    new.workspace_id, 'attachment', new.id, event_action,
    coalesce(auth.uid(), private.request_audit_actor(new.workspace_id)), new.version
  );
  return new;
end;
$$;

revoke all on function private.audit_attachment_change()
  from public, anon, authenticated, service_role;

drop trigger if exists audit_attachment_change on public.attachments;
create trigger audit_attachment_change
after insert or update on public.attachments
for each row execute function private.audit_attachment_change();

create or replace function public.set_attachment_deleted(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_version integer,
  p_restore boolean default false
)
returns setof public.attachments
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.attachments%rowtype;
  parent_is_live boolean;
begin
  if p_restore is null then raise exception 'attachment_restore_flag_required' using errcode = '22023'; end if;
  select * into item
  from public.attachments
  where workspace_id = p_workspace_id and id = p_attachment_id
  for update;
  if not found then raise exception 'attachment_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then
    raise exception 'version_conflict:%', item.version using errcode = '40001';
  end if;
  if item.state <> 'ready' or item.storage_cleanup_completed_at is not null then
    raise exception 'attachment_not_ready' using errcode = '55000';
  end if;

  select (
    (item.task_id is not null and exists (
      select 1 from public.tasks as parent
      where parent.workspace_id = item.workspace_id and parent.id = item.task_id and parent.deleted_at is null
    ))
    or
    (item.knowledge_item_id is not null and exists (
      select 1 from public.knowledge_items as parent
      where parent.workspace_id = item.workspace_id and parent.id = item.knowledge_item_id and parent.deleted_at is null
    ))
  ) into parent_is_live;
  if not parent_is_live then
    raise exception 'attachment_parent_not_found' using errcode = 'P0002';
  end if;

  if p_restore then
    if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
    if item.deleted_at + interval '30 days' <= clock_timestamp() then
      raise exception 'restore_expired' using errcode = '22023';
    end if;
    delete from public.file_cleanup_queue as cleanup
    where cleanup.workspace_id = item.workspace_id
      and cleanup.attachment_id = item.id
      and cleanup.storage_path = item.storage_path
      and cleanup.retain_until is null;
    update public.attachments
    set deleted_at = null
    where workspace_id = item.workspace_id and id = item.id;
  else
    if item.deleted_at is not null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
    update public.attachments
    set deleted_at = clock_timestamp()
    where workspace_id = item.workspace_id and id = item.id;
    perform private.stage_file_cleanup_at(clock_timestamp());
  end if;

  return query
  select * from public.attachments
  where workspace_id = item.workspace_id and id = item.id;
end;
$$;

revoke all on function public.set_attachment_deleted(uuid, uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.set_attachment_deleted(uuid, uuid, integer, boolean)
  to service_role;

create or replace function public.set_task_deleted(
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
  where workspace_id = p_workspace_id and id = p_task_id for update;
  if not found or item.deleted_at is not null then raise exception 'task_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then
    raise exception 'version_conflict:%', item.version using errcode = '40001';
  end if;
  update public.tasks set deleted_at = clock_timestamp()
  where workspace_id = item.workspace_id and id = item.id;
  return query select * from public.tasks
  where workspace_id = item.workspace_id and id = item.id;
end;
$$;

revoke all on function public.set_task_deleted(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.set_task_deleted(uuid, uuid, integer)
  to service_role;

create or replace function public.set_knowledge_deleted(
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
  where workspace_id = p_workspace_id and id = p_knowledge_id for update;
  if not found or item.deleted_at is not null then raise exception 'knowledge_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then
    raise exception 'version_conflict:%', item.version using errcode = '40001';
  end if;
  update public.knowledge_items set deleted_at = clock_timestamp()
  where workspace_id = item.workspace_id and id = item.id;
  return query select * from public.knowledge_items
  where workspace_id = item.workspace_id and id = item.id;
end;
$$;

revoke all on function public.set_knowledge_deleted(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.set_knowledge_deleted(uuid, uuid, integer)
  to service_role;

create or replace function public.set_secure_item_deleted(
  p_workspace_id uuid,
  p_secure_item_id uuid,
  p_expected_version integer
)
returns setof public.secure_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.secure_items%rowtype;
begin
  select * into item from public.secure_items
  where workspace_id = p_workspace_id and id = p_secure_item_id for update;
  if not found or item.deleted_at is not null then raise exception 'secure_item_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then
    raise exception 'version_conflict:%', item.version using errcode = '40001';
  end if;
  update public.secure_items set deleted_at = clock_timestamp()
  where workspace_id = item.workspace_id and id = item.id;
  return query select * from public.secure_items
  where workspace_id = item.workspace_id and id = item.id;
end;
$$;

revoke all on function public.set_secure_item_deleted(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.set_secure_item_deleted(uuid, uuid, integer)
  to service_role;

-- Converge every existing recovery entry point to the same NULL-safe optimistic
-- locking contract. These functions remain service-role-only API primitives.
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
declare item public.tasks%rowtype;
begin
  select * into item from public.tasks
  where id = p_task_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'task_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
  if item.deleted_at + interval '30 days' <= clock_timestamp() then raise exception 'restore_expired' using errcode = '22023'; end if;
  update public.tasks set deleted_at = null
  where id = p_task_id and workspace_id = p_workspace_id;
  return query select * from public.tasks
  where id = p_task_id and workspace_id = p_workspace_id;
end;
$$;

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
declare item public.knowledge_items%rowtype;
begin
  select * into item from public.knowledge_items
  where id = p_knowledge_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'knowledge_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
  if item.deleted_at + interval '30 days' <= clock_timestamp() then raise exception 'restore_expired' using errcode = '22023'; end if;
  update public.knowledge_items set deleted_at = null
  where id = p_knowledge_id and workspace_id = p_workspace_id;
  return query select * from public.knowledge_items
  where id = p_knowledge_id and workspace_id = p_workspace_id;
end;
$$;

create or replace function public.restore_secure_item_record(
  p_workspace_id uuid,
  p_secure_item_id uuid,
  p_expected_version integer
)
returns setof public.secure_items
language plpgsql
security definer
set search_path = ''
as $$
declare item public.secure_items%rowtype;
begin
  select * into item from public.secure_items
  where id = p_secure_item_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'secure_item_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
  if item.deleted_at + interval '30 days' <= clock_timestamp() then raise exception 'restore_expired' using errcode = '22023'; end if;
  update public.secure_items set deleted_at = null
  where id = p_secure_item_id and workspace_id = p_workspace_id;
  return query select * from public.secure_items
  where id = p_secure_item_id and workspace_id = p_workspace_id;
end;
$$;

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
  operation_time timestamptz;
begin
  if p_restore is null then raise exception 'contact_restore_flag_required' using errcode = '22023'; end if;
  select * into item from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'contact_not_found' using errcode = 'P0002'; end if;
  if item.version is distinct from p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  operation_time := clock_timestamp();
  if p_restore then
    if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
    if item.deleted_at + interval '30 days' <= clock_timestamp() then raise exception 'restore_expired' using errcode = '22023'; end if;
    update public.contacts set deleted_at = null
    where id = p_contact_id and workspace_id = p_workspace_id;
    update public.contact_methods set deleted_at = null
    where workspace_id = p_workspace_id and contact_id = p_contact_id and deleted_at = item.deleted_at;
  else
    if item.deleted_at is not null then raise exception 'contact_not_found' using errcode = 'P0002'; end if;
    update public.contacts set deleted_at = operation_time
    where id = p_contact_id and workspace_id = p_workspace_id;
    update public.contact_methods set deleted_at = operation_time
    where workspace_id = p_workspace_id and contact_id = p_contact_id and deleted_at is null;
  end if;
  return query select * from public.contacts
  where id = p_contact_id and workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.restore_task_record(uuid, uuid, integer),
  public.restore_knowledge_record(uuid, uuid, integer),
  public.restore_secure_item_record(uuid, uuid, integer),
  public.set_contact_deleted(uuid, uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.restore_task_record(uuid, uuid, integer),
  public.restore_knowledge_record(uuid, uuid, integer),
  public.restore_secure_item_record(uuid, uuid, integer),
  public.set_contact_deleted(uuid, uuid, integer, boolean)
  to service_role;

create or replace function private.enforce_live_comment_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.deleted_at is null and not exists (
    select 1 from public.tasks as task
    where task.workspace_id = new.workspace_id
      and task.id = new.task_id
      and task.deleted_at is null
  ) then
    raise exception 'comment_parent_not_found' using errcode = 'P0002';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_live_comment_parent()
  from public, anon, authenticated, service_role;

drop trigger if exists enforce_live_comment_parent on public.comments;
create trigger enforce_live_comment_parent
before insert or update of task_id, deleted_at on public.comments
for each row execute function private.enforce_live_comment_parent();

create or replace function private.inherit_task_comment_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.comments
    set deleted_at = new.deleted_at
    where workspace_id = new.workspace_id and task_id = new.id and deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.comments
    set deleted_at = null
    where workspace_id = new.workspace_id and task_id = new.id and deleted_at = old.deleted_at;
  end if;
  return new;
end;
$$;

revoke all on function private.inherit_task_comment_deletion()
  from public, anon, authenticated, service_role;

drop trigger if exists inherit_task_comment_deletion on public.tasks;
create trigger inherit_task_comment_deletion
after update of deleted_at on public.tasks
for each row execute function private.inherit_task_comment_deletion();

alter table public.secure_items
  drop constraint if exists secure_items_external_url_safe_check;

create or replace function private.secure_item_url_is_safe(value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select value is not null
    and char_length(value) between 8 and 2000
    and (
      value ~* '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/?$'
      or value ~* '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/\?itemId=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or value ~* '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/#/vault\?itemId=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    );
$$;

update public.secure_items
set external_url = coalesce(
  substring(external_url from '^(https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)'),
  'https://vault.bitwarden.com'
)
where not private.secure_item_url_is_safe(external_url);

alter table public.secure_items
  add constraint secure_items_external_url_safe_check check (
    private.secure_item_url_is_safe(external_url)
  );

alter table public.knowledge_items
  drop constraint if exists knowledge_items_link_url_safe;

create or replace function private.knowledge_url_is_safe(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  path_value text;
  raw_path_segment text;
  decoded_path_segment text;
  decoded_path_token text;
  decoded_character text;
  decoded_codepoint integer;
  character_index integer;
  distinct_characters integer;
begin
  if value is null then return false; end if;
  if char_length(value) > 2000
    or value !~* '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:/[^?#]*)?$'
  then
    return false;
  end if;

  path_value := regexp_replace(value, '^https://[^/]+', '', 'i');
  foreach raw_path_segment in array string_to_array(path_value, '/') loop
    decoded_path_segment := private.percent_decode_url_component(raw_path_segment);
    if decoded_path_segment is null
      or position('?' in decoded_path_segment) > 0
      or position('#' in decoded_path_segment) > 0
    then
      return false;
    end if;
    for character_index in 1..char_length(decoded_path_segment) loop
      decoded_character := substr(decoded_path_segment, character_index, 1);
      decoded_codepoint := ascii(decoded_character);
      if decoded_codepoint between 0 and 32
        or decoded_codepoint between 127 and 159
        or decoded_codepoint = 160
        or decoded_codepoint = 5760
        or decoded_codepoint between 8192 and 8202
        or decoded_codepoint in (8232, 8233, 8239, 8287, 12288, 65279)
      then
        return false;
      end if;
    end loop;
    foreach decoded_path_token in array string_to_array(decoded_path_segment, '/') loop
      if decoded_path_token ~* '^[a-f0-9]{48,}$' then return false; end if;
      if char_length(decoded_path_token) >= 64 and decoded_path_token ~ '^[A-Za-z0-9_-]+$' then
        select count(distinct character)
        into distinct_characters
        from regexp_split_to_table(decoded_path_token, '') as character;
        if distinct_characters >= 12 then return false; end if;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

update public.knowledge_items
set kind = 'note', link_url = null
where link_url is not null and not private.knowledge_url_is_safe(link_url);

alter table public.knowledge_items
  add constraint knowledge_items_link_url_safe check (
    link_url is null or private.knowledge_url_is_safe(link_url)
  );

create or replace function private.persisted_text_is_safe(value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  url_match text[];
  candidate_url text;
begin
  if value is null then return true; end if;
  if not private.secure_item_text_is_safe(value) then return false; end if;

  for url_match in
    select matched
    from regexp_matches(value, '(https?://[^\t-\r <>"'']*)', 'gi') as matched
  loop
    candidate_url := rtrim(url_match[1], '.,;:!)]}');
    if not private.knowledge_url_is_safe(candidate_url) then return false; end if;
  end loop;
  return true;
end;
$$;

alter table public.tasks drop constraint if exists tasks_persisted_text_safe_check;
alter table public.comments drop constraint if exists comments_persisted_text_safe_check;
alter table public.knowledge_items drop constraint if exists knowledge_items_persisted_text_safe_check;
alter table public.contacts drop constraint if exists contacts_persisted_text_safe_check;
alter table public.secure_items drop constraint if exists secure_items_fixed_fields_check;

update public.tasks
set title = case when private.persisted_text_is_safe(title) then title else 'Задача' end,
  description = case when private.persisted_text_is_safe(description) then description else '' end
where not private.persisted_text_is_safe(title)
  or not private.persisted_text_is_safe(description);

update public.comments
set body = 'Комментарий удалён из-за небезопасной ссылки.'
where not private.persisted_text_is_safe(body);

update public.knowledge_items
set title = case when private.persisted_text_is_safe(title) then title else 'Материал' end,
  body = case when private.persisted_text_is_safe(body) then body else '' end
where not private.persisted_text_is_safe(title)
  or not private.persisted_text_is_safe(body);

update public.contacts
set name = case when private.persisted_text_is_safe(name) then name else 'Контакт' end,
  notes = case when private.persisted_text_is_safe(notes) then notes else '' end
where not private.persisted_text_is_safe(name)
  or not private.persisted_text_is_safe(notes);

update public.secure_items
set title = case when private.persisted_text_is_safe(title) then title else 'Безопасная запись' end,
  purpose = case when private.persisted_text_is_safe(purpose) then purpose else 'Ссылка на запись в Bitwarden' end,
  owner = case when private.persisted_text_is_safe(owner) then owner else 'Команда' end,
  card_bank = case when private.persisted_text_is_safe(card_bank) then card_bank else null end,
  card_holder = case when private.persisted_text_is_safe(card_holder) then card_holder else null end,
  card_purpose = case when private.persisted_text_is_safe(card_purpose) then card_purpose else null end
where not private.persisted_text_is_safe(title)
  or not private.persisted_text_is_safe(purpose)
  or not private.persisted_text_is_safe(owner)
  or not private.persisted_text_is_safe(card_bank)
  or not private.persisted_text_is_safe(card_holder)
  or not private.persisted_text_is_safe(card_purpose);

alter table public.tasks
  add constraint tasks_persisted_text_safe_check check (
    private.persisted_text_is_safe(title)
    and private.persisted_text_is_safe(description)
  );
alter table public.comments
  add constraint comments_persisted_text_safe_check check (
    private.persisted_text_is_safe(body)
  );
alter table public.knowledge_items
  add constraint knowledge_items_persisted_text_safe_check check (
    private.persisted_text_is_safe(title)
    and private.persisted_text_is_safe(body)
  );
alter table public.contacts
  add constraint contacts_persisted_text_safe_check check (
    private.persisted_text_is_safe(name)
    and private.persisted_text_is_safe(notes)
  );
alter table public.secure_items
  add constraint secure_items_fixed_fields_check check (
    char_length(trim(purpose)) between 1 and 2000
    and char_length(trim(owner)) between 1 and 280
    and (card_bank is null or char_length(trim(card_bank)) between 1 and 280)
    and (card_holder is null or char_length(trim(card_holder)) between 1 and 280)
    and (card_purpose is null or char_length(trim(card_purpose)) between 1 and 2000)
    and private.persisted_text_is_safe(title)
    and private.persisted_text_is_safe(purpose)
    and private.persisted_text_is_safe(owner)
    and private.persisted_text_is_safe(card_bank)
    and private.persisted_text_is_safe(card_holder)
    and private.persisted_text_is_safe(card_purpose)
  );

create or replace function private.broadcast_workspace_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_action text;
  event_entity text;
  old_state text;
  new_state text;
begin
  if tg_table_name = 'attachments' then
    new_state := to_jsonb(new) ->> 'state';
    if tg_op = 'UPDATE' then old_state := to_jsonb(old) ->> 'state'; end if;
    if new_state <> 'ready' then return new; end if;
  end if;
  event_entity := case tg_table_name
    when 'tasks' then 'task'
    when 'comments' then 'comment'
    when 'knowledge_items' then 'knowledge'
    when 'contacts' then 'contact'
    when 'contact_methods' then 'contact_method'
    when 'attachments' then 'attachment'
    when 'secure_items' then 'secure_item'
  end;
  if event_entity is null then return new; end if;
  event_action := case
    when tg_table_name = 'attachments' and tg_op = 'UPDATE' and old_state <> 'ready' and new_state = 'ready' then 'created'
    when tg_op = 'INSERT' then 'created'
    when old.deleted_at is null and new.deleted_at is not null then 'deleted'
    when old.deleted_at is not null and new.deleted_at is null then 'restored'
    else 'updated'
  end;
  perform realtime.send(
    jsonb_build_object('entity', event_entity, 'action', event_action),
    'workspace_changed',
    'workspace:' || new.workspace_id::text,
    true
  );
  return new;
end;
$$;

revoke all on function private.broadcast_workspace_change()
  from public, anon, authenticated, service_role;

drop trigger if exists broadcast_workspace_change on public.attachments;
create trigger broadcast_workspace_change
after insert or update on public.attachments
for each row execute function private.broadcast_workspace_change();

drop trigger if exists broadcast_workspace_change on public.secure_items;
create trigger broadcast_workspace_change
after insert or update on public.secure_items
for each row execute function private.broadcast_workspace_change();

revoke execute on all functions in schema private
  from public, anon, authenticated, service_role;
alter default privileges in schema private
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
