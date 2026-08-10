create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists public.app_users (
  id uuid primary key default extensions.gen_random_uuid(),
  telegram_id text not null unique,
  first_name text not null check (char_length(first_name) between 1 and 256),
  last_name text check (last_name is null or char_length(last_name) between 1 and 256),
  username text check (username is null or char_length(username) between 1 and 64),
  display_name text check (display_name is null or char_length(display_name) between 1 and 280),
  avatar_url text check (avatar_url is null or (char_length(avatar_url) <= 2000 and avatar_url ~ '^https://')),
  language_code text check (language_code is null or char_length(language_code) between 1 and 35),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  constraint app_users_telegram_id_format check (
    telegram_id ~ '^[0-9]{1,16}$'
    and telegram_id::numeric between 1 and 4503599627370495
  )
);

create table if not exists public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);

create table if not exists public.workspace_members (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  user_id uuid not null references public.app_users(id),
  display_name text not null check (char_length(display_name) between 1 and 280),
  role text not null default 'member' check (role in ('owner', 'member')),
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, user_id),
  unique (workspace_id, id)
);

create unique index if not exists workspace_members_one_visible_owner_idx
  on public.workspace_members (workspace_id)
  where role = 'owner' and active and deleted_at is null;
create index if not exists workspace_members_user_active_idx
  on public.workspace_members (user_id, workspace_id)
  where active and deleted_at is null;

create table if not exists public.task_statuses (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null check (char_length(name) between 1 and 120),
  position integer not null check (position > 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, name),
  unique (workspace_id, position)
);

create table if not exists public.sections (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null check (char_length(name) between 1 and 120),
  position integer not null check (position > 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, name),
  unique (workspace_id, position)
);

create table if not exists public.tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  title text not null check (char_length(title) between 1 and 280),
  description text not null default '' check (char_length(description) <= 20000),
  priority smallint not null default 3 check (priority between 1 and 5),
  status_id uuid not null,
  section_id uuid,
  assignee_id uuid,
  due_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, status_id) references public.task_statuses(workspace_id, id),
  foreign key (workspace_id, section_id) references public.sections(workspace_id, id),
  foreign key (workspace_id, assignee_id) references public.workspace_members(workspace_id, id)
);

create index if not exists tasks_workspace_visible_due_idx
  on public.tasks (workspace_id, due_at, priority)
  where deleted_at is null;
create index if not exists tasks_workspace_status_idx
  on public.tasks (workspace_id, status_id)
  where deleted_at is null;
create index if not exists tasks_workspace_assignee_idx
  on public.tasks (workspace_id, assignee_id)
  where deleted_at is null;

create table if not exists public.comments (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  task_id uuid not null,
  author_id uuid not null,
  body text not null check (char_length(body) between 1 and 10000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, author_id) references public.workspace_members(workspace_id, id)
);

create index if not exists comments_task_visible_idx
  on public.comments (workspace_id, task_id, created_at)
  where deleted_at is null;

create table if not exists public.knowledge_items (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  title text not null check (char_length(title) between 1 and 280),
  body text not null default '' check (char_length(body) <= 30000),
  kind text not null check (kind in ('note', 'instruction', 'document', 'link')),
  section_id uuid,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, section_id) references public.sections(workspace_id, id)
);

create index if not exists knowledge_items_workspace_kind_idx
  on public.knowledge_items (workspace_id, kind, updated_at desc)
  where deleted_at is null;

create table if not exists public.contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null check (char_length(name) between 1 and 280),
  category text not null default 'other' check (category in ('supplier', 'contractor', 'partner', 'other')),
  notes text not null default '' check (char_length(notes) <= 10000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, id)
);

create index if not exists contacts_workspace_category_idx
  on public.contacts (workspace_id, category, name)
  where deleted_at is null;

create table if not exists public.contact_methods (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  contact_id uuid not null,
  kind text not null check (kind in ('phone', 'telegram', 'whatsapp')),
  value text not null check (char_length(value) between 1 and 300),
  position integer not null default 1 check (position > 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (workspace_id, contact_id) references public.contacts(workspace_id, id),
  unique (contact_id, position)
);

create table if not exists public.secure_items (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  title text not null check (char_length(title) between 1 and 280),
  external_url text not null check (
    char_length(external_url) <= 2000
    and external_url ~ '^https://([A-Za-z0-9-]+\.)*bitwarden\.com([/:]|$)'
  ),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (workspace_id, id)
);

create table if not exists public.attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  task_id uuid,
  knowledge_item_id uuid,
  name text not null check (char_length(name) between 1 and 255),
  mime_type text not null check (char_length(mime_type) between 1 and 200),
  size_bytes bigint not null check (size_bytes between 0 and 26214400),
  storage_path text not null check (char_length(storage_path) between 1 and 1000),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  constraint attachments_single_parent check (num_nonnulls(task_id, knowledge_item_id) = 1),
  constraint attachments_workspace_path check (storage_path like workspace_id::text || '/%'),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, knowledge_item_id) references public.knowledge_items(workspace_id, id),
  unique (workspace_id, storage_path)
);

create index if not exists attachments_task_idx on public.attachments (workspace_id, task_id) where deleted_at is null;
create index if not exists attachments_knowledge_idx on public.attachments (workspace_id, knowledge_item_id) where deleted_at is null;

create table if not exists public.invitations (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  created_by uuid not null,
  role text not null default 'member' check (role = 'member'),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references public.app_users(id),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (workspace_id, created_by) references public.workspace_members(workspace_id, id),
  constraint invitations_usage_consistent check ((used_at is null) = (used_by is null)),
  constraint invitations_expiry_after_creation check (expires_at > created_at)
);

create index if not exists invitations_workspace_live_idx
  on public.invitations (workspace_id, expires_at)
  where used_at is null and deleted_at is null;

create table if not exists public.reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  task_id uuid not null,
  recipient_id uuid not null,
  remind_at timestamptz not null,
  channel text not null default 'telegram' check (channel = 'telegram'),
  state text not null default 'pending' check (state in ('pending', 'sent', 'cancelled')),
  sent_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, recipient_id) references public.workspace_members(workspace_id, id),
  constraint reminders_sent_state_consistent check ((state = 'sent') = (sent_at is not null)),
  unique (workspace_id, task_id, recipient_id, remind_at, channel)
);

create index if not exists reminders_pending_idx
  on public.reminders (remind_at, workspace_id)
  where state = 'pending' and deleted_at is null;

create table if not exists public.audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  entity_type text not null check (entity_type in ('task', 'comment', 'knowledge', 'contact', 'secure_item')),
  entity_id uuid not null,
  action text not null check (action in ('created', 'updated', 'deleted', 'restored')),
  actor_user_id uuid references public.app_users(id),
  entity_version integer not null check (entity_version > 0),
  occurred_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id)
);

create index if not exists audit_events_workspace_timeline_idx
  on public.audit_events (workspace_id, occurred_at desc, id);
create index if not exists audit_events_entity_idx
  on public.audit_events (workspace_id, entity_type, entity_id, occurred_at desc);

create table if not exists public.notification_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  event_id uuid not null,
  channel text not null check (channel = 'telegram'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  available_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (event_id, channel),
  unique (workspace_id, id, event_id),
  foreign key (workspace_id, event_id) references public.audit_events(workspace_id, id)
);

do $notification_outbox_legacy_index$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notification_outbox' and column_name = 'deleted_at'
  ) then
    execute 'create index if not exists notification_outbox_pending_idx
      on public.notification_outbox (available_at, created_at)
      where delivered_at is null and deleted_at is null';
  end if;
end;
$notification_outbox_legacy_index$;

create table if not exists public.notification_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  event_id uuid not null,
  outbox_id uuid not null,
  channel text not null check (channel = 'telegram'),
  delivered_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  unique (event_id, channel),
  unique (outbox_id),
  foreign key (workspace_id, event_id) references public.audit_events(workspace_id, id),
  foreign key (workspace_id, outbox_id, event_id)
    references public.notification_outbox(workspace_id, id, event_id)
);

create or replace function private.set_record_metadata()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  new.version := old.version + 1;
  return new;
end;
$$;

do $triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'app_users', 'workspaces', 'workspace_members', 'task_statuses', 'sections', 'tasks',
    'comments', 'knowledge_items', 'contacts', 'contact_methods', 'secure_items', 'attachments',
    'invitations', 'reminders', 'notification_outbox', 'notification_deliveries'
  ] loop
    execute format('drop trigger if exists set_record_metadata on public.%I', table_name);
    execute format(
      'create trigger set_record_metadata before update on public.%I for each row execute function private.set_record_metadata()',
      table_name
    );
  end loop;
end;
$triggers$;

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
    new.workspace_id, event_entity, new.id, event_action, auth.uid(), new.version
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

do $triggers$
declare
  table_name text;
begin
  foreach table_name in array array['tasks', 'comments', 'knowledge_items', 'contacts', 'secure_items'] loop
    execute format('drop trigger if exists audit_workspace_change on public.%I', table_name);
    execute format(
      'create trigger audit_workspace_change after insert or update on public.%I for each row execute function private.audit_workspace_change()',
      table_name
    );
  end loop;
end;
$triggers$;

create or replace function private.reject_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events are append-only' using errcode = '55000';
end;
$$;

drop trigger if exists reject_audit_mutation on public.audit_events;
create trigger reject_audit_mutation
before update or delete on public.audit_events
for each row execute function private.reject_audit_mutation();

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
  if selected_user_deleted_at is not null then
    return;
  end if;

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

create or replace function public.get_active_membership(p_user_id uuid, p_workspace_id uuid)
returns table (
  user_id uuid,
  membership_id uuid,
  workspace_id uuid,
  role text,
  active boolean,
  display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select wm.user_id, wm.id, wm.workspace_id, wm.role, wm.active, wm.display_name
  from public.workspace_members wm
  join public.app_users au on au.id = wm.user_id
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = p_user_id
    and wm.workspace_id = p_workspace_id
    and wm.active
    and wm.deleted_at is null
    and au.deleted_at is null
    and w.deleted_at is null
  limit 1
$$;

create or replace function public.create_workspace_invitation(
  p_workspace_id uuid,
  p_creator_user_id uuid,
  p_role text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns table (invitation_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  creator_membership_id uuid;
  created_invitation_id uuid;
  database_now timestamptz := clock_timestamp();
begin
  if p_role <> 'member' or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at <= database_now or p_expires_at > database_now + interval '24 hours' then
    raise exception 'invalid_invitation' using errcode = '22023';
  end if;

  select wm.id into creator_membership_id
  from public.workspace_members wm
  join public.app_users au on au.id = wm.user_id
  join public.workspaces w on w.id = wm.workspace_id
  where wm.workspace_id = p_workspace_id
    and wm.user_id = p_creator_user_id
    and wm.role = 'owner'
    and wm.active
    and wm.deleted_at is null
    and au.deleted_at is null
    and w.deleted_at is null
  for share;
  if creator_membership_id is null then
    raise exception 'owner_required' using errcode = '42501';
  end if;

  insert into public.invitations (workspace_id, created_by, role, token_hash, expires_at)
  values (p_workspace_id, creator_membership_id, p_role, decode(p_token_hash, 'hex'), p_expires_at)
  returning id into created_invitation_id;

  return query select created_invitation_id, p_expires_at;
end;
$$;

create or replace function public.redeem_workspace_invitation(
  p_token_hash text,
  p_telegram_id text,
  p_first_name text,
  p_last_name text default null,
  p_username text default null,
  p_language_code text default null
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
  selected_invitation public.invitations%rowtype;
  selected_user_id uuid;
  selected_membership_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  select invitation.* into selected_invitation
  from public.invitations invitation
  where invitation.token_hash = decode(p_token_hash, 'hex') and invitation.deleted_at is null
  for update;

  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  elsif selected_invitation.used_at is not null then
    raise exception 'invitation_used' using errcode = 'P0001';
  elsif selected_invitation.expires_at <= clock_timestamp() then
    raise exception 'invitation_expired' using errcode = 'P0001';
  end if;

  insert into public.app_users (telegram_id, first_name, last_name, username, language_code)
  values (p_telegram_id, p_first_name, p_last_name, p_username, p_language_code)
  on conflict (telegram_id) do update set
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    username = excluded.username,
    language_code = excluded.language_code
  where public.app_users.deleted_at is null
  returning id into selected_user_id;
  if selected_user_id is null then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  insert into public.workspace_members (workspace_id, user_id, display_name, role, active, deleted_at)
  values (
    selected_invitation.workspace_id,
    selected_user_id,
    trim(concat_ws(' ', p_first_name, p_last_name)),
    selected_invitation.role,
    true,
    null
  )
  on conflict on constraint workspace_members_workspace_id_user_id_key do update set
    display_name = excluded.display_name,
    active = true,
    deleted_at = null
  returning id into selected_membership_id;

  update public.invitations
  set used_at = clock_timestamp(), used_by = selected_user_id
  where id = selected_invitation.id and used_at is null;
  if not found then
    raise exception 'invitation_used' using errcode = 'P0001';
  end if;

  return query
  select wm.user_id, wm.id, wm.workspace_id, wm.role, wm.active, wm.display_name
  from public.workspace_members wm
  where wm.id = selected_membership_id;
end;
$$;

revoke all on function public.bootstrap_telegram_user(text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.get_active_membership(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_workspace_invitation(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.redeem_workspace_invitation(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.bootstrap_telegram_user(text, text, text, text, text, text, text) to service_role;
grant execute on function public.get_active_membership(uuid, uuid) to service_role;
grant execute on function public.create_workspace_invitation(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.redeem_workspace_invitation(text, text, text, text, text, text) to service_role;
