-- Task 7: recipient-scoped Telegram notifications and production operations.

-- Localized-name inference is a one-time legacy conversion only. Once the
-- column exists, a replay must preserve the workspace's explicit flags.
do $add_explicit_completion_flag$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'task_statuses'
      and column_name = 'is_completed'
  ) then
    alter table public.task_statuses
      add column is_completed boolean not null default false;
    update public.task_statuses
    set is_completed = true
    where name = 'Готово';
  end if;
end;
$add_explicit_completion_flag$;

-- Keep workspace bootstrap correct for workspaces created after this migration.
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
    insert into public.task_statuses (workspace_id, name, position, is_completed)
    values
      (target_workspace_id, 'Новая', 1, false),
      (target_workspace_id, 'В работе', 2, false),
      (target_workspace_id, 'Ждёт', 3, false),
      (target_workspace_id, 'Готово', 4, true)
    on conflict (workspace_id, name) do update set
      position = excluded.position,
      deleted_at = null;
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

revoke all on function private.ensure_workspace_taxonomy(uuid)
  from public, anon, authenticated, service_role;

-- The old tables represented one generic event/channel row and cannot be
-- interpreted as recipient-scoped delivery intent. Retire them only on the
-- first upgrade; a reapplication preserves the new operational state.
do $replace_generic_notification_tables$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notification_outbox'
      and column_name = 'channel'
  ) then
    drop table if exists public.notification_deliveries;
    drop table if exists public.notification_outbox;
  end if;
end;
$replace_generic_notification_tables$;

create table if not exists public.notification_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  task_id uuid not null,
  recipient_id uuid not null,
  source_event_id uuid,
  kind text not null check (kind in ('assignment', 'mention', 'due_24h', 'overdue_daily')),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 300),
  due_at_snapshot timestamptz,
  overdue_local_date date,
  available_at timestamptz not null default clock_timestamp(),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 8),
  last_error_code text check (last_error_code is null or last_error_code in (
    'rate_limited', 'telegram_unavailable', 'network_error',
    'recipient_unavailable', 'configuration_error', 'invalid_response',
    'delivery_indeterminate'
  )),
  delivered_at timestamptz,
  failed_at timestamptz,
  dead_letter_at timestamptz,
  suppressed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  unique (workspace_id, id, task_id, recipient_id),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, recipient_id) references public.workspace_members(workspace_id, id),
  foreign key (workspace_id, source_event_id) references public.audit_events(workspace_id, id),
  constraint notification_outbox_kind_source_check check (
    (kind in ('assignment', 'mention') and source_event_id is not null
      and due_at_snapshot is null and overdue_local_date is null)
    or (kind = 'due_24h' and source_event_id is null
      and due_at_snapshot is not null and overdue_local_date is null)
    or (kind = 'overdue_daily' and source_event_id is null
      and due_at_snapshot is not null and overdue_local_date is not null)
  ),
  constraint notification_outbox_lease_check check ((lease_id is null) = (lease_expires_at is null)),
  constraint notification_outbox_terminal_check check (
    num_nonnulls(delivered_at, dead_letter_at, suppressed_at) <= 1
    and ((failed_at is null) = (dead_letter_at is null))
    and (delivered_at is null or (lease_id is null and last_error_code is null))
    and (dead_letter_at is null or (lease_id is null and last_error_code is not null))
    and (suppressed_at is null or (lease_id is null and last_error_code is null))
  )
);

create index if not exists notification_outbox_pending_idx
  on public.notification_outbox (available_at, created_at, id)
  where delivered_at is null and dead_letter_at is null and suppressed_at is null;

create table if not exists public.notification_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  task_id uuid not null,
  recipient_id uuid not null,
  outbox_id uuid not null unique,
  telegram_message_id bigint not null check (telegram_message_id > 0),
  delivered_at timestamptz not null default clock_timestamp(),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, recipient_id) references public.workspace_members(workspace_id, id),
  foreign key (workspace_id, outbox_id, task_id, recipient_id)
    references public.notification_outbox(workspace_id, id, task_id, recipient_id)
);

create table if not exists public.telegram_webhook_updates (
  update_id bigint primary key check (update_id >= 0),
  received_at timestamptz not null default clock_timestamp()
);

drop trigger if exists set_record_metadata on public.notification_outbox;
create trigger set_record_metadata before update on public.notification_outbox
for each row execute function private.set_record_metadata();
drop trigger if exists set_record_metadata on public.notification_deliveries;
create trigger set_record_metadata before update on public.notification_deliveries
for each row execute function private.set_record_metadata();

alter table public.notification_outbox enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.telegram_webhook_updates enable row level security;
revoke all privileges on public.notification_outbox, public.notification_deliveries
  from public, anon, authenticated;
revoke all privileges on public.telegram_webhook_updates
  from public, anon, authenticated;
grant all privileges on public.notification_outbox, public.notification_deliveries
  to service_role;
grant all privileges on public.telegram_webhook_updates
  to service_role;

-- Preserve the existing append-only audit event and add only recipient-scoped,
-- content-free assignment and mention intents.
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
  mention_recipient record;
  task_assignee_id uuid;
  previous_task_assignee_id uuid;
  task_status_id uuid;
  comment_task_id uuid;
  comment_author_id uuid;
  comment_body text;
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
    new.workspace_id, event_entity, new.id, event_action,
    coalesce(auth.uid(), private.request_audit_actor(new.workspace_id)), new.version
  ) returning id into created_event_id;

  if tg_table_name = 'tasks' then
    task_assignee_id := nullif(to_jsonb(new) ->> 'assignee_id', '')::uuid;
    task_status_id := nullif(to_jsonb(new) ->> 'status_id', '')::uuid;
    previous_task_assignee_id := case
      when tg_op = 'UPDATE' then nullif(to_jsonb(old) ->> 'assignee_id', '')::uuid
      else null
    end;

    if new.deleted_at is null
      and task_assignee_id is not null
      and (tg_op = 'INSERT' or previous_task_assignee_id is distinct from task_assignee_id)
      and exists (
        select 1
        from public.workspace_members as member
        join public.app_users as app_user on app_user.id = member.user_id
        join public.task_statuses as status
          on status.workspace_id = new.workspace_id and status.id = task_status_id
        where member.workspace_id = new.workspace_id
          and member.id = task_assignee_id
          and member.active
          and member.deleted_at is null
          and app_user.deleted_at is null
          and status.deleted_at is null
          and not status.is_completed
      )
    then
      insert into public.notification_outbox (
        workspace_id, task_id, recipient_id, source_event_id, kind, idempotency_key
      ) values (
        new.workspace_id, new.id, task_assignee_id, created_event_id, 'assignment',
        'assignment:' || created_event_id::text || ':' || task_assignee_id::text
      ) on conflict (idempotency_key) do nothing;
    end if;
  end if;

  if tg_table_name = 'comments' then
    comment_task_id := nullif(to_jsonb(new) ->> 'task_id', '')::uuid;
    comment_author_id := nullif(to_jsonb(new) ->> 'author_id', '')::uuid;
    comment_body := to_jsonb(new) ->> 'body';

    if tg_op = 'INSERT' and new.deleted_at is null then
      for mention_recipient in
        select distinct member.id
        from regexp_matches(
          comment_body,
          '(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{5,64})',
          'gi'
        ) as found(parts)
        join public.app_users as app_user
          on lower(app_user.username) = lower((found.parts)[2])
        join public.workspace_members as member
          on member.workspace_id = new.workspace_id and member.user_id = app_user.id
        join public.tasks as task
          on task.workspace_id = new.workspace_id and task.id = comment_task_id
        join public.task_statuses as status
          on status.workspace_id = task.workspace_id and status.id = task.status_id
        where member.id <> comment_author_id
          and member.active
          and member.deleted_at is null
          and app_user.deleted_at is null
          and task.deleted_at is null
          and status.deleted_at is null
          and not status.is_completed
      loop
        insert into public.notification_outbox (
          workspace_id, task_id, recipient_id, source_event_id, kind, idempotency_key
        ) values (
          new.workspace_id, comment_task_id, mention_recipient.id, created_event_id, 'mention',
          'mention:' || created_event_id::text || ':' || mention_recipient.id::text
        ) on conflict (idempotency_key) do nothing;
      end loop;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.audit_workspace_change()
  from public, anon, authenticated, service_role;

create or replace function private.plan_task_notifications_at(p_observed_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer := 0;
  current_count integer := 0;
  local_date date;
  local_time time;
begin
  if p_observed_at is null then
    raise exception 'notification_clock_invalid' using errcode = '22023';
  end if;

  local_date := (p_observed_at at time zone 'Europe/Moscow')::date;
  local_time := (p_observed_at at time zone 'Europe/Moscow')::time;

  insert into public.notification_outbox (
    workspace_id, task_id, recipient_id, kind, idempotency_key,
    due_at_snapshot, available_at
  )
  select
    task.workspace_id,
    task.id,
    member.id,
    'due_24h',
    'due_24h:' || task.workspace_id::text || ':' || task.id::text || ':'
      || member.id::text || ':'
      || ((extract(epoch from task.due_at) * 1000000)::bigint)::text,
    task.due_at,
    p_observed_at
  from public.tasks as task
  join public.task_statuses as status
    on status.workspace_id = task.workspace_id and status.id = task.status_id
  join public.workspace_members as member
    on member.workspace_id = task.workspace_id and member.id = task.assignee_id
  join public.app_users as app_user on app_user.id = member.user_id
  join public.workspaces as workspace on workspace.id = task.workspace_id
  where task.deleted_at is null
    and task.due_at > p_observed_at
    and task.due_at <= p_observed_at + interval '24 hours'
    and status.deleted_at is null
    and not status.is_completed
    and member.active
    and member.deleted_at is null
    and app_user.deleted_at is null
    and workspace.deleted_at is null
  on conflict (idempotency_key) do nothing;
  get diagnostics current_count = row_count;
  inserted_count := inserted_count + current_count;

  if local_time >= time '10:00:00' then
    insert into public.notification_outbox (
      workspace_id, task_id, recipient_id, kind, idempotency_key,
      due_at_snapshot, overdue_local_date, available_at
    )
    select
      task.workspace_id,
      task.id,
      member.id,
      'overdue_daily',
      'overdue_daily:' || task.workspace_id::text || ':' || task.id::text || ':'
        || member.id::text || ':' || to_char(local_date, 'YYYY-MM-DD'),
      task.due_at,
      local_date,
      p_observed_at
    from public.tasks as task
    join public.task_statuses as status
      on status.workspace_id = task.workspace_id and status.id = task.status_id
    join public.workspace_members as member
      on member.workspace_id = task.workspace_id and member.id = task.assignee_id
    join public.app_users as app_user on app_user.id = member.user_id
    join public.workspaces as workspace on workspace.id = task.workspace_id
    where task.deleted_at is null
      and task.due_at < p_observed_at
      and status.deleted_at is null
      and not status.is_completed
      and member.active
      and member.deleted_at is null
      and app_user.deleted_at is null
      and workspace.deleted_at is null
    on conflict (idempotency_key) do nothing;
    get diagnostics current_count = row_count;
    inserted_count := inserted_count + current_count;
  end if;

  return inserted_count;
end;
$$;

revoke all on function private.plan_task_notifications_at(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.plan_task_notifications()
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.plan_task_notifications_at(clock_timestamp())
$$;

revoke all on function public.plan_task_notifications()
  from public, anon, authenticated;
grant execute on function public.plan_task_notifications()
  to service_role;

create or replace function public.claim_notification_outbox(p_limit integer)
returns table (
  id uuid,
  lease_id uuid,
  kind text,
  task_id uuid,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  observed_at timestamptz := clock_timestamp();
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'notification_batch_invalid' using errcode = '22023';
  end if;

  -- An eighth delivery can crash after Telegram has accepted the request but
  -- before its outcome is persisted. Once that final lease expires, retain the
  -- effectively-once ambiguity as a redacted terminal state; never attempt a
  -- ninth send.
  with expired_max_leases as (
    select queue.id
    from public.notification_outbox as queue
    where queue.attempts = 8
      and queue.lease_id is not null
      and queue.lease_expires_at <= observed_at
      and queue.delivered_at is null
      and queue.dead_letter_at is null
      and queue.suppressed_at is null
    order by queue.lease_expires_at, queue.id
    for update skip locked
    limit p_limit
  )
  update public.notification_outbox as queue
  set failed_at = observed_at,
      dead_letter_at = observed_at,
      last_error_code = 'delivery_indeterminate',
      lease_id = null,
      lease_expires_at = null
  from expired_max_leases
  where queue.id = expired_max_leases.id;

  return query
  with candidates as (
    select queue.id
    from public.notification_outbox as queue
    where queue.available_at <= observed_at
      and queue.delivered_at is null
      and queue.dead_letter_at is null
      and queue.suppressed_at is null
      and queue.attempts < 8
      and (queue.lease_id is null or queue.lease_expires_at <= observed_at)
    order by
      case when queue.lease_id is not null and queue.lease_expires_at <= observed_at then 0 else 1 end,
      queue.available_at,
      queue.created_at,
      queue.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.notification_outbox as queue
    set lease_id = extensions.gen_random_uuid(),
        lease_expires_at = observed_at + interval '5 minutes',
        attempts = queue.attempts + 1
    from candidates
    where queue.id = candidates.id
    returning queue.id, queue.lease_id, queue.kind, queue.task_id, queue.attempts
  )
  select claimed.id, claimed.lease_id, claimed.kind, claimed.task_id, claimed.attempts
  from claimed;
end;
$$;

revoke all on function public.claim_notification_outbox(integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_outbox(integer)
  to service_role;

create or replace function private.revalidate_notification_outbox_at(
  p_outbox_id uuid,
  p_lease_id uuid,
  p_observed_at timestamptz
)
returns table (telegram_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue public.notification_outbox%rowtype;
  observed_at timestamptz;
begin
  select * into queue
  from public.notification_outbox
  where id = p_outbox_id and lease_id = p_lease_id
  for update;
  if not found then return; end if;

  -- A null clock is the production path: acquire the row lock first, then
  -- refresh the database clock. The explicit clock is private test support.
  observed_at := coalesce(p_observed_at, clock_timestamp());
  if queue.lease_expires_at is null or queue.lease_expires_at <= observed_at
    or queue.delivered_at is not null or queue.dead_letter_at is not null
    or queue.suppressed_at is not null
  then
    return;
  end if;

  return query
  select app_user.telegram_id
  from public.tasks as task
  join public.task_statuses as status
    on status.workspace_id = task.workspace_id and status.id = task.status_id
  join public.workspace_members as member
    on member.workspace_id = task.workspace_id and member.id = queue.recipient_id
  join public.app_users as app_user on app_user.id = member.user_id
  join public.workspaces as workspace on workspace.id = task.workspace_id
  where task.workspace_id = queue.workspace_id
    and task.id = queue.task_id
    and task.deleted_at is null
    and status.deleted_at is null
    and not status.is_completed
    and member.active
    and member.deleted_at is null
    and app_user.deleted_at is null
    and workspace.deleted_at is null
    and (
      (queue.kind = 'assignment' and task.assignee_id = queue.recipient_id)
      or (
        queue.kind = 'due_24h'
        and task.assignee_id = queue.recipient_id
        and task.due_at = queue.due_at_snapshot
        and task.due_at > observed_at
        and task.due_at <= observed_at + interval '24 hours'
      )
      or (
        queue.kind = 'overdue_daily'
        and task.assignee_id = queue.recipient_id
        and task.due_at = queue.due_at_snapshot
        and task.due_at < observed_at
        and queue.overdue_local_date = (observed_at at time zone 'Europe/Moscow')::date
        and (observed_at at time zone 'Europe/Moscow')::time >= time '10:00:00'
      )
      or (
        queue.kind = 'mention'
        and exists (
          select 1
          from public.audit_events as event
          join public.comments as comment
            on comment.workspace_id = event.workspace_id
           and comment.id = event.entity_id
          where event.workspace_id = queue.workspace_id
            and event.id = queue.source_event_id
            and event.entity_type = 'comment'
            and comment.task_id = queue.task_id
            and comment.author_id <> queue.recipient_id
            and comment.deleted_at is null
            and exists (
              select 1
              from regexp_matches(
                comment.body,
                '(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{5,64})',
                'gi'
              ) as found(parts)
              where lower((found.parts)[2]) = lower(app_user.username)
            )
        )
      )
    );
end;
$$;

revoke all on function private.revalidate_notification_outbox_at(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.revalidate_notification_outbox(
  p_outbox_id uuid,
  p_lease_id uuid
)
returns table (telegram_id text)
language sql
security definer
set search_path = ''
as $$
  select *
  from private.revalidate_notification_outbox_at(p_outbox_id, p_lease_id, null)
$$;

revoke all on function public.revalidate_notification_outbox(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revalidate_notification_outbox(uuid, uuid)
  to service_role;

create or replace function private.suppress_notification_outbox_at(
  p_outbox_id uuid,
  p_lease_id uuid,
  p_observed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue public.notification_outbox%rowtype;
  observed_at timestamptz;
begin
  select * into queue
  from public.notification_outbox
  where id = p_outbox_id and lease_id = p_lease_id
  for update;
  if not found then return false; end if;

  -- Refresh only after the potentially blocking row lock.
  observed_at := coalesce(p_observed_at, clock_timestamp());
  if queue.lease_expires_at is null or queue.lease_expires_at <= observed_at
    or queue.delivered_at is not null or queue.dead_letter_at is not null
    or queue.suppressed_at is not null
  then
    return false;
  end if;

  update public.notification_outbox
  set suppressed_at = observed_at,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null
  where id = queue.id;
  return true;
end;
$$;

revoke all on function private.suppress_notification_outbox_at(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.suppress_notification_outbox(
  p_outbox_id uuid,
  p_lease_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.suppress_notification_outbox_at(p_outbox_id, p_lease_id, null)
$$;

revoke all on function public.suppress_notification_outbox(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.suppress_notification_outbox(uuid, uuid)
  to service_role;

create or replace function public.complete_notification_outbox(
  p_outbox_id uuid,
  p_lease_id uuid,
  p_telegram_message_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue public.notification_outbox%rowtype;
  observed_at timestamptz;
begin
  if p_telegram_message_id is null or p_telegram_message_id <= 0 then
    raise exception 'telegram_message_id_invalid' using errcode = '22023';
  end if;

  select * into queue
  from public.notification_outbox
  where id = p_outbox_id and lease_id = p_lease_id
  for update;
  if not found then return false; end if;

  observed_at := clock_timestamp();
  if queue.lease_expires_at is null
    or queue.delivered_at is not null or queue.dead_letter_at is not null
    or queue.suppressed_at is not null
  then
    return false;
  end if;

  insert into public.notification_deliveries (
    workspace_id, task_id, recipient_id, outbox_id,
    telegram_message_id, delivered_at
  ) values (
    queue.workspace_id, queue.task_id, queue.recipient_id, queue.id,
    p_telegram_message_id, observed_at
  );

  update public.notification_outbox
  set delivered_at = observed_at,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null
  where id = queue.id;
  return true;
end;
$$;

revoke all on function public.complete_notification_outbox(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.complete_notification_outbox(uuid, uuid, bigint)
  to service_role;

create or replace function public.fail_notification_outbox(
  p_outbox_id uuid,
  p_lease_id uuid,
  p_error_code text,
  p_retry_after_seconds integer,
  p_permanent boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue public.notification_outbox%rowtype;
  observed_at timestamptz;
begin
  if p_error_code is null or p_error_code not in (
    'rate_limited', 'telegram_unavailable', 'network_error',
    'recipient_unavailable', 'configuration_error', 'invalid_response'
  ) then
    raise exception 'notification_error_code_invalid' using errcode = '22023';
  end if;
  if p_retry_after_seconds is null or p_retry_after_seconds not between 0 and 3600
    or p_permanent is null
  then
    raise exception 'notification_retry_invalid' using errcode = '22023';
  end if;

  select * into queue
  from public.notification_outbox
  where id = p_outbox_id and lease_id = p_lease_id
  for update;
  if not found then return 'ignored'; end if;

  observed_at := clock_timestamp();
  if queue.lease_expires_at is null or queue.lease_expires_at <= observed_at
    or queue.delivered_at is not null or queue.dead_letter_at is not null
    or queue.suppressed_at is not null
  then
    return 'ignored';
  end if;

  if p_permanent or queue.attempts >= 8 then
    update public.notification_outbox
    set failed_at = observed_at,
        dead_letter_at = observed_at,
        last_error_code = p_error_code,
        lease_id = null,
        lease_expires_at = null
    where id = queue.id;
    return 'dead_letter';
  end if;

  update public.notification_outbox
  set available_at = observed_at + make_interval(secs => p_retry_after_seconds),
      last_error_code = p_error_code,
      lease_id = null,
      lease_expires_at = null
  where id = queue.id;
  return 'retry';
end;
$$;

revoke all on function public.fail_notification_outbox(uuid, uuid, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.fail_notification_outbox(uuid, uuid, text, integer, boolean)
  to service_role;

create or replace function public.record_telegram_webhook_update(p_update_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_update_id is null or p_update_id < 0 then
    raise exception 'telegram_update_id_invalid' using errcode = '22023';
  end if;

  insert into public.telegram_webhook_updates (update_id)
  values (p_update_id)
  on conflict (update_id) do nothing;
  return found;
end;
$$;

revoke all on function public.record_telegram_webhook_update(bigint)
  from public, anon, authenticated;
grant execute on function public.record_telegram_webhook_update(bigint)
  to service_role;

create or replace function public.get_authorized_task_launch(
  p_user_id uuid,
  p_workspace_id uuid,
  p_membership_id uuid,
  p_task_id uuid
)
returns table (task_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select task.id
  from public.workspace_members as member
  join public.app_users as app_user on app_user.id = member.user_id
  join public.workspaces as workspace on workspace.id = member.workspace_id
  join public.tasks as task
    on task.workspace_id = member.workspace_id and task.id = p_task_id
  join public.task_statuses as status
    on status.workspace_id = task.workspace_id and status.id = task.status_id
  where member.id = p_membership_id
    and member.user_id = p_user_id
    and member.workspace_id = p_workspace_id
    and member.active
    and member.deleted_at is null
    and app_user.deleted_at is null
    and workspace.deleted_at is null
    and task.deleted_at is null
    and status.deleted_at is null
  limit 1
$$;

revoke all on function public.get_authorized_task_launch(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_authorized_task_launch(uuid, uuid, uuid, uuid)
  to service_role;

-- A verified Telegram identity may probe session establishment without earning a
-- persistent application-user row. This bounded service-only ledger is the only
-- write performed before existing membership or signed invitation authorization.
create table if not exists public.telegram_session_rate_limits (
  telegram_id text primary key check (
    telegram_id ~ '^[0-9]{1,16}$'
    and telegram_id::numeric between 1 and 4503599627370495
  ),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts between 1 and 21),
  last_attempt_at timestamptz not null
);

alter table public.telegram_session_rate_limits enable row level security;
revoke all privileges on public.telegram_session_rate_limits from public, anon, authenticated;
grant all privileges on public.telegram_session_rate_limits to service_role;

create or replace function public.consume_telegram_session_attempt(p_telegram_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  observed_at timestamptz := clock_timestamp();
  current_attempts integer;
begin
  if p_telegram_id !~ '^[0-9]{1,16}$'
    or p_telegram_id::numeric not between 1 and 4503599627370495
  then
    raise exception 'invalid_telegram_identity' using errcode = '22023';
  end if;

  insert into public.telegram_session_rate_limits (
    telegram_id, window_started_at, attempts, last_attempt_at
  ) values (p_telegram_id, observed_at, 1, observed_at)
  on conflict (telegram_id) do update set
    window_started_at = case
      when public.telegram_session_rate_limits.window_started_at <= observed_at - interval '1 minute'
        then observed_at
      else public.telegram_session_rate_limits.window_started_at
    end,
    attempts = case
      when public.telegram_session_rate_limits.window_started_at <= observed_at - interval '1 minute'
        then 1
      else least(public.telegram_session_rate_limits.attempts + 1, 21)
    end,
    last_attempt_at = observed_at
  returning attempts into current_attempts;
  return current_attempts <= 20;
end;
$$;

revoke all on function public.consume_telegram_session_attempt(text)
  from public, anon, authenticated;
grant execute on function public.consume_telegram_session_attempt(text) to service_role;

-- Only the configured owner may create a profile from ordinary session bootstrap.
-- Everyone else must already have a live membership; their profile is updated only
-- after that authorization and only when a value actually changed.
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
  selected_workspace_id uuid;
  selected_membership_id uuid;
  selected_membership_active boolean;
  selected_membership_deleted_at timestamptz;
  selected_workspace_deleted_at timestamptz;
begin
  if p_telegram_id !~ '^[0-9]{1,16}$'
    or p_telegram_id::numeric not between 1 and 4503599627370495
    or p_first_name is null
    or char_length(p_first_name) not between 1 and 256
  then
    raise exception 'invalid_telegram_identity' using errcode = '22023';
  end if;

  if p_telegram_id <> p_owner_telegram_id then
    select app_user.id, member.id, member.workspace_id
    into selected_user_id, selected_membership_id, selected_workspace_id
    from public.app_users as app_user
    join public.workspace_members as member on member.user_id = app_user.id
    join public.workspaces as workspace on workspace.id = member.workspace_id
    where app_user.telegram_id = p_telegram_id
      and app_user.deleted_at is null
      and member.active
      and member.deleted_at is null
      and workspace.deleted_at is null
    order by (member.role = 'owner') desc, member.created_at
    limit 1;
    if selected_user_id is null then return; end if;

    update public.app_users
    set first_name = p_first_name,
      last_name = p_last_name,
      username = p_username,
      language_code = p_language_code
    where id = selected_user_id
      and (first_name, last_name, username, language_code)
        is distinct from (p_first_name, p_last_name, p_username, p_language_code);
  else
    perform pg_advisory_xact_lock(hashtextextended('smoking-zen-owner-bootstrap', 0));
    insert into public.app_users (telegram_id, first_name, last_name, username, language_code)
    values (p_telegram_id, p_first_name, p_last_name, p_username, p_language_code)
    on conflict (telegram_id) do update set
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      username = excluded.username,
      language_code = excluded.language_code
    where public.app_users.deleted_at is null
      and (public.app_users.first_name, public.app_users.last_name,
        public.app_users.username, public.app_users.language_code)
        is distinct from (excluded.first_name, excluded.last_name,
          excluded.username, excluded.language_code)
    returning id into selected_user_id;

    if selected_user_id is null then
      select id into selected_user_id from public.app_users
      where telegram_id = p_telegram_id and deleted_at is null;
    end if;
    if selected_user_id is null then return; end if;

    select member.workspace_id, member.id, member.active, member.deleted_at, workspace.deleted_at
    into selected_workspace_id, selected_membership_id, selected_membership_active,
      selected_membership_deleted_at, selected_workspace_deleted_at
    from public.workspace_members as member
    join public.workspaces as workspace on workspace.id = member.workspace_id
    where member.user_id = selected_user_id and member.role = 'owner'
    order by member.created_at
    limit 1;

    if selected_workspace_id is null then
      insert into public.workspaces (name) values (p_workspace_name)
      returning id into selected_workspace_id;
      insert into public.workspace_members (workspace_id, user_id, display_name, role, active)
      values (
        selected_workspace_id, selected_user_id,
        trim(concat_ws(' ', p_first_name, p_last_name)), 'owner', true
      ) returning id into selected_membership_id;
    elsif not selected_membership_active
      or selected_membership_deleted_at is not null
      or selected_workspace_deleted_at is not null
    then
      return;
    end if;
    perform private.ensure_workspace_taxonomy(selected_workspace_id);
  end if;

  return query
  select app_user.id, member.id, member.workspace_id, member.role,
    member.active and member.deleted_at is null, member.display_name
  from public.app_users as app_user
  join public.workspace_members as member on member.user_id = app_user.id
  join public.workspaces as workspace on workspace.id = member.workspace_id
  where app_user.id = selected_user_id
    and member.id = selected_membership_id
    and app_user.deleted_at is null
    and member.active
    and member.deleted_at is null
    and workspace.deleted_at is null;
end;
$$;

revoke all on function public.bootstrap_telegram_user(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_telegram_user(text, text, text, text, text, text, text)
  to service_role;

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
  selected_user public.app_users%rowtype;
  existing_membership public.workspace_members%rowtype;
  selected_user_id uuid;
  selected_membership_id uuid;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$'
    or p_telegram_id !~ '^[0-9]{1,16}$'
    or p_telegram_id::numeric not between 1 and 4503599627370495
    or p_first_name is null
    or char_length(p_first_name) not between 1 and 256
  then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  select invitation.* into selected_invitation
  from public.invitations as invitation
  where invitation.token_hash = decode(p_token_hash, 'hex')
    and invitation.deleted_at is null
  for update;
  if not found
    or selected_invitation.used_at is not null
    or selected_invitation.expires_at <= clock_timestamp()
  then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  select app_user.* into selected_user
  from public.app_users as app_user
  where app_user.telegram_id = p_telegram_id
  for update;
  if selected_user.id is not null and selected_user.deleted_at is not null then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  if selected_user.id is not null then
    select member.* into existing_membership
    from public.workspace_members as member
    where member.workspace_id = selected_invitation.workspace_id
      and member.user_id = selected_user.id
    for update;
    if existing_membership.id is not null
      and existing_membership.active
      and existing_membership.deleted_at is null
    then
      raise exception 'invitation_invalid' using errcode = 'P0001';
    end if;
    update public.app_users
    set first_name = p_first_name, last_name = p_last_name,
      username = p_username, language_code = p_language_code
    where id = selected_user.id
      and (first_name, last_name, username, language_code)
        is distinct from (p_first_name, p_last_name, p_username, p_language_code);
    selected_user_id := selected_user.id;
  else
    insert into public.app_users (telegram_id, first_name, last_name, username, language_code)
    values (p_telegram_id, p_first_name, p_last_name, p_username, p_language_code)
    returning id into selected_user_id;
  end if;

  insert into public.workspace_members (
    workspace_id, user_id, display_name, role, active, deleted_at
  ) values (
    selected_invitation.workspace_id, selected_user_id,
    trim(concat_ws(' ', p_first_name, p_last_name)), selected_invitation.role, true, null
  )
  on conflict on constraint workspace_members_workspace_id_user_id_key do update set
    display_name = excluded.display_name,
    role = excluded.role,
    active = true,
    deleted_at = null
  returning id into selected_membership_id;

  update public.invitations
  set used_at = clock_timestamp(), used_by = selected_user_id
  where id = selected_invitation.id and used_at is null;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;

  return query
  select member.user_id, member.id, member.workspace_id, member.role, member.active, member.display_name
  from public.workspace_members as member where member.id = selected_membership_id;
end;
$$;

revoke all on function public.redeem_workspace_invitation(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.redeem_workspace_invitation(text, text, text, text, text, text)
  to service_role;
