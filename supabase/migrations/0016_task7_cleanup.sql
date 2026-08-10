-- Durable database-clock cleanup, opaque orphan reconciliation, and child-first purge.

alter table public.attachments
  add column if not exists storage_cleanup_completed_at timestamptz;

do $file_cleanup_bounded_attempt_upgrade$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'file_cleanup_queue'
      and column_name = 'dead_lettered_at'
  ) then
    alter table public.file_cleanup_queue
      add column dead_lettered_at timestamptz;
    update public.file_cleanup_queue
    set attempts = case
        when first_remove_succeeded_at is not null and lease_id is null then 0
        else least(attempts, 8)
      end,
      last_error_code = case
        when last_error_code is null then null
        when last_error_code in ('storage_unavailable', 'indeterminate_timeout') then last_error_code
        else 'storage_unavailable'
      end;
  end if;
end;
$file_cleanup_bounded_attempt_upgrade$;

alter table public.file_cleanup_queue
  drop constraint if exists file_cleanup_queue_attempts_check;
alter table public.file_cleanup_queue
  add constraint file_cleanup_queue_attempts_check check (attempts between 0 and 8);
alter table public.file_cleanup_queue
  drop constraint if exists file_cleanup_queue_last_error_code_check;
alter table public.file_cleanup_queue
  add constraint file_cleanup_queue_last_error_code_check check (
    last_error_code is null
    or last_error_code in ('storage_unavailable', 'indeterminate_timeout')
  );
alter table public.file_cleanup_queue
  drop constraint if exists file_cleanup_queue_dead_letter_check;
alter table public.file_cleanup_queue
  add constraint file_cleanup_queue_dead_letter_check check (
    dead_lettered_at is null
    or (
      attempts = 8
      and lease_id is null
      and lease_expires_at is null
      and last_error_code is not null
    )
  );

alter table public.attachments
  drop constraint if exists attachments_storage_cleanup_completed_check;
alter table public.attachments
  add constraint attachments_storage_cleanup_completed_check check (
    storage_cleanup_completed_at is null
    or (
      state = 'ready'
      and deleted_at is not null
      and (
        (storage_layout = 'opaque' and storage_path = id::text)
        or (
          storage_layout = 'legacy'
          and storage_path ~ (
            '^' || workspace_id::text || '/ready/'
            || '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
        )
      )
    )
  );

create or replace function private.protect_attachment_cleanup_receipts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (
    (old.storage_cleanup_completed_at is null and new.storage_cleanup_completed_at is not null)
    or (old.quarantine_cleanup_completed_at is null and new.quarantine_cleanup_completed_at is not null)
  ) and current_user <> 'postgres' then
    raise exception 'attachment_cleanup_receipt_forbidden' using errcode = '42501';
  end if;
  if old.storage_cleanup_completed_at is not null
    and new.storage_cleanup_completed_at is distinct from old.storage_cleanup_completed_at
  then
    raise exception 'attachment_cleanup_receipt_immutable' using errcode = '55000';
  end if;
  if old.quarantine_cleanup_completed_at is not null
    and new.quarantine_cleanup_completed_at is distinct from old.quarantine_cleanup_completed_at
  then
    raise exception 'attachment_cleanup_receipt_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_attachment_cleanup_receipts()
  from public, anon, authenticated, service_role;

drop trigger if exists protect_attachment_cleanup_receipts on public.attachments;
create trigger protect_attachment_cleanup_receipts
before update on public.attachments
for each row execute function private.protect_attachment_cleanup_receipts();

-- Parent deletion is inherited exactly. Ready objects are not eligible until the
-- database clock is strictly beyond the thirty-day recovery boundary.
create or replace function private.inherit_parent_attachment_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    if tg_table_name = 'tasks' then
      update public.attachments
      set deleted_at = new.deleted_at
      where workspace_id = new.workspace_id
        and task_id = new.id
        and deleted_at is null;
    elsif tg_table_name = 'knowledge_items' then
      update public.attachments
      set deleted_at = new.deleted_at
      where workspace_id = new.workspace_id
        and knowledge_item_id = new.id
        and deleted_at is null;
    end if;
  elsif old.deleted_at is not null and new.deleted_at is null then
    if tg_table_name = 'tasks' then
      delete from public.file_cleanup_queue as cleanup
      using public.attachments as attachment
      where attachment.workspace_id = new.workspace_id
        and attachment.task_id = new.id
        and attachment.state = 'ready'
        and attachment.deleted_at = old.deleted_at
        and attachment.storage_cleanup_completed_at is null
        and cleanup.workspace_id = attachment.workspace_id
        and cleanup.attachment_id = attachment.id
        and cleanup.storage_path = attachment.storage_path
        and cleanup.retain_until is null;
      update public.attachments
      set deleted_at = null
      where workspace_id = new.workspace_id
        and task_id = new.id
        and state = 'ready'
        and deleted_at = old.deleted_at
        and storage_cleanup_completed_at is null;
    elsif tg_table_name = 'knowledge_items' then
      delete from public.file_cleanup_queue as cleanup
      using public.attachments as attachment
      where attachment.workspace_id = new.workspace_id
        and attachment.knowledge_item_id = new.id
        and attachment.state = 'ready'
        and attachment.deleted_at = old.deleted_at
        and attachment.storage_cleanup_completed_at is null
        and cleanup.workspace_id = attachment.workspace_id
        and cleanup.attachment_id = attachment.id
        and cleanup.storage_path = attachment.storage_path
        and cleanup.retain_until is null;
      update public.attachments
      set deleted_at = null
      where workspace_id = new.workspace_id
        and knowledge_item_id = new.id
        and state = 'ready'
        and deleted_at = old.deleted_at
      and storage_cleanup_completed_at is null;
    end if;
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    perform private.stage_file_cleanup_at(clock_timestamp());
  end if;
  return new;
end;
$$;

revoke all on function private.inherit_parent_attachment_deletion()
  from public, anon, authenticated, service_role;

drop trigger if exists inherit_task_attachment_deletion on public.tasks;
create trigger inherit_task_attachment_deletion
after update of deleted_at on public.tasks
for each row execute function private.inherit_parent_attachment_deletion();

drop trigger if exists inherit_knowledge_attachment_deletion on public.knowledge_items;
create trigger inherit_knowledge_attachment_deletion
after update of deleted_at on public.knowledge_items
for each row execute function private.inherit_parent_attachment_deletion();

create or replace function private.stage_file_cleanup_at(p_observed_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer := 0;
  changed integer;
begin
  if p_observed_at is null then
    raise exception 'cleanup_clock_required' using errcode = '22023';
  end if;

  with candidates as (
    select attachment.workspace_id, attachment.id, parent.deleted_at
    from public.attachments as attachment
    join public.tasks as parent
      on parent.workspace_id = attachment.workspace_id and parent.id = attachment.task_id
    where parent.deleted_at is not null and attachment.deleted_at is null
    order by parent.deleted_at, attachment.id
    limit 100
    for update of attachment skip locked
  )
  update public.attachments as attachment
  set deleted_at = candidate.deleted_at
  from candidates as candidate
  where attachment.workspace_id = candidate.workspace_id and attachment.id = candidate.id;
  get diagnostics changed = row_count;
  affected := affected + changed;

  with candidates as (
    select attachment.workspace_id, attachment.id, parent.deleted_at
    from public.attachments as attachment
    join public.knowledge_items as parent
      on parent.workspace_id = attachment.workspace_id and parent.id = attachment.knowledge_item_id
    where parent.deleted_at is not null and attachment.deleted_at is null
    order by parent.deleted_at, attachment.id
    limit 100
    for update of attachment skip locked
  )
  update public.attachments as attachment
  set deleted_at = candidate.deleted_at
  from candidates as candidate
  where attachment.workspace_id = candidate.workspace_id and attachment.id = candidate.id;
  get diagnostics changed = row_count;
  affected := affected + changed;

  -- Expired live quarantine rows become durable tombstones before Storage work.
  with candidates as (
    select workspace_id, id
    from public.attachments
    where state = 'quarantine'
      and deleted_at is null
      and quarantine_expires_at <= p_observed_at
    order by quarantine_expires_at, id
    limit 100
    for update skip locked
  )
  update public.attachments as attachment
  set deleted_at = p_observed_at
  from candidates as candidate
  where attachment.workspace_id = candidate.workspace_id and attachment.id = candidate.id;
  get diagnostics changed = row_count;
  affected := affected + changed;

  insert into public.file_cleanup_queue (
    workspace_id, attachment_id, storage_path, remove_after, retain_until
  )
  select
    attachment.workspace_id,
    attachment.id,
    attachment.storage_path,
    attachment.deleted_at + interval '30 days',
    null
  from public.attachments as attachment
  where attachment.state = 'ready'
    and attachment.deleted_at is not null
    and attachment.storage_cleanup_completed_at is null
    and (
      (attachment.storage_layout = 'opaque' and attachment.storage_path = attachment.id::text)
      or (
        attachment.storage_layout = 'legacy'
        and attachment.storage_path ~ (
          '^' || attachment.workspace_id::text || '/ready/'
          || '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
      )
    )
    and not exists (
      select 1 from public.file_cleanup_queue as existing
      where existing.storage_path = attachment.storage_path
    )
  order by attachment.deleted_at, attachment.id
  limit 100
  on conflict (storage_path) do nothing;
  get diagnostics changed = row_count;
  affected := affected + changed;

  insert into public.file_cleanup_queue (
    workspace_id, attachment_id, storage_path, remove_after, retain_until
  )
  select
    attachment.workspace_id,
    attachment.id,
    attachment.storage_path,
    greatest(attachment.quarantine_expires_at, p_observed_at),
    greatest(attachment.quarantine_expires_at, p_observed_at) + interval '24 hours'
  from public.attachments as attachment
  where attachment.state = 'quarantine'
    and attachment.deleted_at is not null
    and attachment.quarantine_cleanup_completed_at is null
    and attachment.quarantine_expires_at is not null
    and not exists (
      select 1 from public.file_cleanup_queue as existing
      where existing.storage_path = attachment.storage_path
    )
  order by attachment.deleted_at, attachment.id
  limit 100
  on conflict (storage_path) do nothing;
  get diagnostics changed = row_count;
  affected := affected + changed;

  return affected;
end;
$$;

revoke all on function private.stage_file_cleanup_at(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.stage_file_cleanup()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  select private.stage_file_cleanup_at(clock_timestamp())
$$;

revoke all on function public.stage_file_cleanup() from public, anon, authenticated;
grant execute on function public.stage_file_cleanup() to service_role;

create or replace function public.list_due_file_cleanup()
returns table (id uuid, workspace_id uuid, storage_path text)
language sql
volatile
security definer
set search_path = ''
as $$
  with observed as (
    select clock_timestamp() as at
  ),
  expired_max as (
    select cleanup.id
    from public.file_cleanup_queue as cleanup, observed
    where cleanup.attempts = 8
      and cleanup.lease_expires_at <= observed.at
      and cleanup.dead_lettered_at is null
    order by cleanup.lease_expires_at, cleanup.id
    limit 50
    for update of cleanup skip locked
  ),
  terminalized as (
    update public.file_cleanup_queue as cleanup
    set dead_lettered_at = observed.at,
      last_error_code = 'indeterminate_timeout',
      lease_id = null,
      lease_expires_at = null
    from expired_max, observed
    where cleanup.id = expired_max.id
    returning cleanup.id
  )
  select cleanup.id, cleanup.workspace_id, cleanup.storage_path
  from public.file_cleanup_queue as cleanup, observed
  where cleanup.remove_after < observed.at
    and cleanup.attempts < 8
    and cleanup.dead_lettered_at is null
    and (cleanup.lease_id is null or cleanup.lease_expires_at <= observed.at)
    and (select count(*) from terminalized) >= 0
  order by cleanup.remove_after, cleanup.created_at, cleanup.id
  limit 50
$$;

revoke all on function public.list_due_file_cleanup() from public, anon, authenticated;
grant execute on function public.list_due_file_cleanup() to service_role;

create or replace function public.prepare_file_cleanup_object(p_queue_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.file_cleanup_queue%rowtype;
  attachment public.attachments%rowtype;
  observed_at timestamptz;
  cleanup_lease uuid;
begin
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id
  for update skip locked;
  if not found then return null; end if;

  observed_at := clock_timestamp();
  if candidate.remove_after >= observed_at
    or candidate.dead_lettered_at is not null
    or candidate.attempts >= 8
    or (candidate.lease_id is not null and candidate.lease_expires_at > observed_at)
  then
    return null;
  end if;

  if candidate.attachment_id is not null then
    select * into attachment
    from public.attachments
    where workspace_id = candidate.workspace_id and id = candidate.attachment_id
    for update;

    if found and attachment.state = 'ready' and attachment.storage_path = candidate.storage_path then
      if attachment.deleted_at is null or attachment.storage_cleanup_completed_at is not null then
        delete from public.file_cleanup_queue where id = candidate.id;
        return null;
      end if;
      if attachment.deleted_at + interval '30 days' >= observed_at then
        update public.file_cleanup_queue
        set remove_after = attachment.deleted_at + interval '30 days',
          lease_id = null, lease_expires_at = null
        where id = candidate.id;
        return null;
      end if;
    end if;

    if found
      and attachment.state = 'quarantine'
      and attachment.storage_path = candidate.storage_path
      and attachment.deleted_at is null
      and attachment.quarantine_expires_at > observed_at
    then
      update public.file_cleanup_queue
      set remove_after = attachment.quarantine_expires_at,
        retain_until = greatest(
          coalesce(retain_until, attachment.quarantine_expires_at + interval '24 hours'),
          attachment.quarantine_expires_at + interval '24 hours'
        ),
        lease_id = null,
        lease_expires_at = null
      where id = candidate.id;
      return null;
    end if;
  end if;

  if exists (
    select 1 from public.attachments as referenced
    where referenced.state = 'ready'
      and referenced.deleted_at is null
      and referenced.storage_path = candidate.storage_path
  ) then
    delete from public.file_cleanup_queue where id = candidate.id;
    return null;
  end if;

  cleanup_lease := extensions.gen_random_uuid();
  update public.file_cleanup_queue
  set lease_id = cleanup_lease,
    lease_expires_at = observed_at + interval '5 minutes',
    attempts = attempts + 1
  where id = candidate.id;
  return cleanup_lease;
end;
$$;

revoke all on function public.prepare_file_cleanup_object(uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_file_cleanup_object(uuid) to service_role;

create or replace function public.finish_file_cleanup_object(
  p_queue_id uuid,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.file_cleanup_queue%rowtype;
  attachment public.attachments%rowtype;
  observed_at timestamptz;
  second_sweep_at timestamptz;
begin
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id and lease_id = p_lease_id
  for update;
  if not found then return false; end if;

  observed_at := clock_timestamp();
  if candidate.lease_expires_at is null or candidate.lease_expires_at <= observed_at then
    return false;
  end if;

  if candidate.retain_until is not null and candidate.first_remove_succeeded_at is null then
    second_sweep_at := greatest(candidate.retain_until, observed_at + interval '24 hours');
    update public.file_cleanup_queue
    set first_remove_succeeded_at = observed_at,
      remove_after = second_sweep_at,
      retain_until = second_sweep_at,
      attempts = 0,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null
    where id = candidate.id;
    return false;
  end if;

  if candidate.attachment_id is not null then
    select * into attachment
    from public.attachments
    where workspace_id = candidate.workspace_id and id = candidate.attachment_id
    for update;

    if found and candidate.retain_until is not null then
      if attachment.state = 'quarantine'
        and attachment.deleted_at is not null
        and attachment.storage_path = candidate.storage_path
      then
        update public.attachments
        set quarantine_cleanup_completed_at = coalesce(quarantine_cleanup_completed_at, observed_at)
        where workspace_id = candidate.workspace_id
          and id = candidate.attachment_id
          and state = 'quarantine'
          and deleted_at is not null
          and storage_path = candidate.storage_path;
        if not found then return false; end if;
      elsif not (
        attachment.state = 'quarantine'
        and attachment.storage_layout = 'opaque'
        and candidate.storage_path = attachment.id::text
        and attachment.storage_path <> candidate.storage_path
      ) then
        return false;
      end if;
    elsif found and candidate.retain_until is null then
      update public.attachments
      set storage_cleanup_completed_at = coalesce(storage_cleanup_completed_at, observed_at)
      where workspace_id = candidate.workspace_id
        and id = candidate.attachment_id
        and state = 'ready'
        and deleted_at is not null
        and storage_path = candidate.storage_path;
      if not found then return false; end if;
    end if;
  end if;

  delete from public.file_cleanup_queue where id = candidate.id;
  return true;
end;
$$;

revoke all on function public.finish_file_cleanup_object(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_file_cleanup_object(uuid, uuid) to service_role;

create or replace function public.fail_file_cleanup_object(
  p_queue_id uuid,
  p_lease_id uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.file_cleanup_queue%rowtype;
  observed_at timestamptz;
begin
  if p_error_code is distinct from 'storage_unavailable' then
    raise exception 'file_cleanup_error_invalid' using errcode = '22023';
  end if;
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id and lease_id = p_lease_id
  for update;
  if not found then return false; end if;
  observed_at := clock_timestamp();
  update public.file_cleanup_queue
  set last_error_code = p_error_code,
    remove_after = greatest(remove_after, observed_at + interval '5 minutes'),
    lease_id = null,
    lease_expires_at = null,
    dead_lettered_at = case when attempts >= 8 then observed_at else dead_lettered_at end
  where id = candidate.id;
  return true;
end;
$$;

revoke all on function public.fail_file_cleanup_object(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_file_cleanup_object(uuid, uuid, text) to service_role;

create table if not exists public.global_file_orphan_queue (
  storage_path text primary key check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  provider_created_at timestamptz not null,
  first_seen_at timestamptz not null,
  remove_after timestamptz not null,
  lease_id uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 8),
  last_error_code text check (
    last_error_code is null
    or last_error_code in ('storage_unavailable', 'indeterminate_timeout')
  ),
  first_remove_succeeded_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  dead_lettered_at timestamptz,
  constraint global_file_orphan_queue_lease_check check (
    (lease_id is null and lease_expires_at is null)
    or (lease_id is not null and lease_expires_at is not null)
  ),
  constraint global_file_orphan_queue_terminal_check check (
    num_nonnulls(completed_at, cancelled_at, dead_lettered_at) <= 1
  ),
  constraint global_file_orphan_queue_first_success_check check (
    first_remove_succeeded_at is null
    or remove_after >= first_remove_succeeded_at + interval '24 hours'
  ),
  constraint global_file_orphan_queue_provider_age_check check (
    first_seen_at > provider_created_at
  ),
  constraint global_file_orphan_queue_grace_check check (
    remove_after >= first_seen_at + interval '24 hours'
  )
);

create index if not exists global_file_orphan_queue_due_idx
  on public.global_file_orphan_queue (remove_after, first_seen_at, storage_path)
  where completed_at is null and cancelled_at is null and dead_lettered_at is null;

alter table public.global_file_orphan_queue enable row level security;
revoke all privileges on public.global_file_orphan_queue from public, anon, authenticated;
grant all privileges on public.global_file_orphan_queue to service_role;

create or replace function private.protect_global_file_orphan_anchors()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.storage_path is distinct from old.storage_path
    or new.provider_created_at is distinct from old.provider_created_at
    or new.first_seen_at is distinct from old.first_seen_at
    or (old.first_remove_succeeded_at is not null
      and new.first_remove_succeeded_at is distinct from old.first_remove_succeeded_at)
    or (old.completed_at is not null and new.completed_at is distinct from old.completed_at)
    or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at)
    or (old.dead_lettered_at is not null and new.dead_lettered_at is distinct from old.dead_lettered_at)
  then
    raise exception 'orphan_cleanup_anchor_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_global_file_orphan_anchors()
  from public, anon, authenticated, service_role;

drop trigger if exists protect_global_file_orphan_anchors on public.global_file_orphan_queue;
create trigger protect_global_file_orphan_anchors
before update on public.global_file_orphan_queue
for each row execute function private.protect_global_file_orphan_anchors();

create or replace function private.discover_global_file_orphans_at(p_observed_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  discovered integer;
begin
  if p_observed_at is null then
    raise exception 'cleanup_clock_required' using errcode = '22023';
  end if;

  insert into public.global_file_orphan_queue (
    storage_path, provider_created_at, first_seen_at, remove_after
  )
  select
    object.name,
    object.created_at,
    p_observed_at,
    p_observed_at + interval '24 hours'
  from storage.objects as object
  where object.bucket_id = 'workspace-files'
    and object.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and object.created_at < p_observed_at - interval '24 hours'
    and not exists (
      select 1 from public.attachments as attachment
      where attachment.storage_path = object.name
    )
    and not exists (
      select 1 from public.file_cleanup_queue as cleanup
      where cleanup.storage_path = object.name
    )
    and not exists (
      select 1 from public.global_file_orphan_queue as existing
      where existing.storage_path = object.name
    )
  order by object.created_at, object.name
  limit 100
  on conflict (storage_path) do nothing;
  get diagnostics discovered = row_count;
  return discovered;
end;
$$;

revoke all on function private.discover_global_file_orphans_at(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.discover_global_file_orphans()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  select private.discover_global_file_orphans_at(clock_timestamp())
$$;

revoke all on function public.discover_global_file_orphans() from public, anon, authenticated;
grant execute on function public.discover_global_file_orphans() to service_role;

create or replace function public.list_due_global_file_orphans()
returns table (storage_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  observed_at timestamptz := clock_timestamp();
begin
  with expired_max as (
    select candidate.storage_path
    from public.global_file_orphan_queue as candidate
    where candidate.attempts = 8
      and candidate.lease_expires_at <= observed_at
      and candidate.completed_at is null
      and candidate.cancelled_at is null
      and candidate.dead_lettered_at is null
    order by candidate.lease_expires_at, candidate.storage_path
    limit 50
    for update skip locked
  )
  update public.global_file_orphan_queue as candidate
  set dead_lettered_at = observed_at,
    last_error_code = 'indeterminate_timeout',
    lease_id = null,
    lease_expires_at = null
  from expired_max
  where candidate.storage_path = expired_max.storage_path;

  return query
  select candidate.storage_path
  from public.global_file_orphan_queue as candidate
  where candidate.remove_after < observed_at
    and candidate.attempts < 8
    and candidate.completed_at is null
    and candidate.cancelled_at is null
    and candidate.dead_lettered_at is null
    and (candidate.lease_id is null or candidate.lease_expires_at <= observed_at)
  order by candidate.remove_after, candidate.first_seen_at, candidate.storage_path
  limit 50;
end;
$$;

revoke all on function public.list_due_global_file_orphans() from public, anon, authenticated;
grant execute on function public.list_due_global_file_orphans() to service_role;

create or replace function private.prepare_global_file_orphan_at(
  p_storage_path text,
  p_observed_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.global_file_orphan_queue%rowtype;
  cleanup_lease uuid;
begin
  if p_observed_at is null then
    raise exception 'cleanup_clock_required' using errcode = '22023';
  end if;
  select * into candidate
  from public.global_file_orphan_queue
  where storage_path = p_storage_path
  for update skip locked;
  if not found then return null; end if;

  if candidate.completed_at is not null
    or candidate.cancelled_at is not null
    or candidate.dead_lettered_at is not null
    or candidate.attempts >= 8
    or candidate.remove_after >= p_observed_at
    or (candidate.lease_id is not null and candidate.lease_expires_at > p_observed_at)
  then
    return null;
  end if;

  if exists (select 1 from public.attachments where storage_path = p_storage_path)
    or exists (select 1 from public.file_cleanup_queue where storage_path = p_storage_path)
  then
    update public.global_file_orphan_queue
    set cancelled_at = p_observed_at,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null
    where storage_path = p_storage_path;
    return null;
  end if;

  cleanup_lease := extensions.gen_random_uuid();
  update public.global_file_orphan_queue
  set lease_id = cleanup_lease,
    lease_expires_at = p_observed_at + interval '5 minutes',
    attempts = attempts + 1
  where storage_path = p_storage_path;
  return cleanup_lease;
end;
$$;

revoke all on function private.prepare_global_file_orphan_at(text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.prepare_global_file_orphan(p_storage_path text)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select private.prepare_global_file_orphan_at(p_storage_path, clock_timestamp())
$$;

revoke all on function public.prepare_global_file_orphan(text) from public, anon, authenticated;
grant execute on function public.prepare_global_file_orphan(text) to service_role;

create or replace function private.finish_global_file_orphan_at(
  p_storage_path text,
  p_lease_id uuid,
  p_observed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.global_file_orphan_queue%rowtype;
  second_sweep_at timestamptz;
begin
  select * into candidate
  from public.global_file_orphan_queue
  where storage_path = p_storage_path and lease_id = p_lease_id
  for update;
  if not found then return false; end if;
  if p_observed_at is null
    or candidate.lease_expires_at is null
    or candidate.lease_expires_at <= p_observed_at
  then
    return false;
  end if;

  if exists (select 1 from public.attachments where storage_path = p_storage_path)
    or exists (select 1 from public.file_cleanup_queue where storage_path = p_storage_path)
  then
    update public.global_file_orphan_queue
    set cancelled_at = p_observed_at,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null
    where storage_path = p_storage_path;
    return false;
  end if;

  if candidate.first_remove_succeeded_at is null then
    second_sweep_at := greatest(candidate.remove_after, p_observed_at + interval '24 hours');
    update public.global_file_orphan_queue
    set first_remove_succeeded_at = p_observed_at,
      remove_after = second_sweep_at,
      attempts = 0,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null
    where storage_path = p_storage_path;
    return false;
  end if;

  update public.global_file_orphan_queue
  set completed_at = p_observed_at,
    lease_id = null,
    lease_expires_at = null,
    last_error_code = null
  where storage_path = p_storage_path;
  return true;
end;
$$;

revoke all on function private.finish_global_file_orphan_at(text, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.finish_global_file_orphan(
  p_storage_path text,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.global_file_orphan_queue%rowtype;
  observed_at timestamptz;
begin
  select * into candidate
  from public.global_file_orphan_queue
  where storage_path = p_storage_path and lease_id = p_lease_id
  for update;
  if not found then return false; end if;
  observed_at := clock_timestamp();
  return private.finish_global_file_orphan_at(p_storage_path, p_lease_id, observed_at);
end;
$$;

revoke all on function public.finish_global_file_orphan(text, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_global_file_orphan(text, uuid) to service_role;

create or replace function public.fail_global_file_orphan(
  p_storage_path text,
  p_lease_id uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  observed_at timestamptz;
begin
  if p_error_code is distinct from 'storage_unavailable' then
    raise exception 'orphan_cleanup_error_invalid' using errcode = '22023';
  end if;
  perform 1
  from public.global_file_orphan_queue
  where storage_path = p_storage_path and lease_id = p_lease_id
  for update;
  if not found then return false; end if;
  observed_at := clock_timestamp();
  update public.global_file_orphan_queue
  set last_error_code = p_error_code,
    remove_after = greatest(remove_after, observed_at + interval '5 minutes'),
    lease_id = null,
    lease_expires_at = null,
    dead_lettered_at = case when attempts >= 8 then observed_at else dead_lettered_at end
  where storage_path = p_storage_path;
  return true;
end;
$$;

revoke all on function public.fail_global_file_orphan(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_global_file_orphan(text, uuid, text) to service_role;

create or replace function private.purge_deleted_records_at(p_observed_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz;
  task_ids uuid[];
  knowledge_ids uuid[];
  contact_ids uuid[];
  changed integer;
  purged integer := 0;
begin
  if p_observed_at is null then
    raise exception 'cleanup_clock_required' using errcode = '22023';
  end if;
  cutoff := p_observed_at - interval '30 days';

  select coalesce(array_agg(candidate.id), '{}'::uuid[]) into task_ids
  from (
    select id from public.tasks
    where deleted_at < cutoff
      and not exists (
        select 1 from public.attachments as attachment
        where attachment.workspace_id = public.tasks.workspace_id
          and attachment.task_id = public.tasks.id
          and not (
            attachment.deleted_at < cutoff
            and (
              (attachment.state = 'ready' and attachment.storage_cleanup_completed_at is not null)
              or (attachment.state = 'quarantine' and attachment.quarantine_cleanup_completed_at is not null)
            )
            and not exists (
              select 1 from public.file_cleanup_queue as cleanup
              where cleanup.workspace_id = attachment.workspace_id
                and (cleanup.attachment_id = attachment.id or cleanup.storage_path = attachment.storage_path)
            )
          )
      )
    order by deleted_at, id
    limit 100
    for update skip locked
  ) as candidate;

  delete from public.notification_deliveries as delivery
  using public.notification_outbox as outbox
  where outbox.id = delivery.outbox_id
    and outbox.workspace_id = delivery.workspace_id
    and outbox.task_id = any(task_ids);
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.notification_outbox where task_id = any(task_ids);
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.comments where task_id = any(task_ids);
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.reminders where task_id = any(task_ids);
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.attachments as attachment
  where attachment.task_id = any(task_ids)
    and attachment.deleted_at < cutoff
    and (
      (attachment.state = 'ready' and attachment.storage_cleanup_completed_at is not null)
      or (attachment.state = 'quarantine' and attachment.quarantine_cleanup_completed_at is not null)
    )
    and not exists (
      select 1 from public.file_cleanup_queue as cleanup
      where cleanup.workspace_id = attachment.workspace_id
        and (cleanup.attachment_id = attachment.id or cleanup.storage_path = attachment.storage_path)
    );
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.tasks as parent
  where parent.id = any(task_ids)
    and not exists (
      select 1 from public.attachments as attachment
      where attachment.workspace_id = parent.workspace_id and attachment.task_id = parent.id
    );
  get diagnostics changed = row_count; purged := purged + changed;

  select coalesce(array_agg(candidate.id), '{}'::uuid[]) into knowledge_ids
  from (
    select id from public.knowledge_items
    where deleted_at < cutoff
      and not exists (
        select 1 from public.attachments as attachment
        where attachment.workspace_id = public.knowledge_items.workspace_id
          and attachment.knowledge_item_id = public.knowledge_items.id
          and not (
            attachment.deleted_at < cutoff
            and (
              (attachment.state = 'ready' and attachment.storage_cleanup_completed_at is not null)
              or (attachment.state = 'quarantine' and attachment.quarantine_cleanup_completed_at is not null)
            )
            and not exists (
              select 1 from public.file_cleanup_queue as cleanup
              where cleanup.workspace_id = attachment.workspace_id
                and (cleanup.attachment_id = attachment.id or cleanup.storage_path = attachment.storage_path)
            )
          )
      )
    order by deleted_at, id
    limit 100
    for update skip locked
  ) as candidate;
  delete from public.attachments as attachment
  where attachment.knowledge_item_id = any(knowledge_ids)
    and attachment.deleted_at < cutoff
    and (
      (attachment.state = 'ready' and attachment.storage_cleanup_completed_at is not null)
      or (attachment.state = 'quarantine' and attachment.quarantine_cleanup_completed_at is not null)
    )
    and not exists (
      select 1 from public.file_cleanup_queue as cleanup
      where cleanup.workspace_id = attachment.workspace_id
        and (cleanup.attachment_id = attachment.id or cleanup.storage_path = attachment.storage_path)
    );
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.knowledge_items as parent
  where parent.id = any(knowledge_ids)
    and not exists (
      select 1 from public.attachments as attachment
      where attachment.workspace_id = parent.workspace_id and attachment.knowledge_item_id = parent.id
    );
  get diagnostics changed = row_count; purged := purged + changed;

  -- Independently deleted children and completed attachment tombstones converge too.
  delete from public.comments where deleted_at < cutoff;
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.reminders where deleted_at < cutoff;
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.attachments as attachment
  where attachment.deleted_at < cutoff
    and (
      (attachment.state = 'ready' and attachment.storage_cleanup_completed_at is not null)
      or (attachment.state = 'quarantine' and attachment.quarantine_cleanup_completed_at is not null)
    )
    and not exists (
      select 1 from public.file_cleanup_queue as cleanup
      where cleanup.workspace_id = attachment.workspace_id
        and (cleanup.attachment_id = attachment.id or cleanup.storage_path = attachment.storage_path)
    );
  get diagnostics changed = row_count; purged := purged + changed;

  select coalesce(array_agg(candidate.id), '{}'::uuid[]) into contact_ids
  from (
    select id from public.contacts
    where deleted_at < cutoff
    order by deleted_at, id
    limit 100
    for update skip locked
  ) as candidate;
  delete from public.contact_methods where contact_id = any(contact_ids);
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.contacts where id = any(contact_ids);
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.contact_methods where deleted_at < cutoff;
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.secure_items where id in (
    select id from public.secure_items
    where deleted_at < cutoff
    order by deleted_at, id limit 100
  );
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.invitations where id in (
    select id from public.invitations
    where (deleted_at < cutoff or used_at < cutoff or expires_at < cutoff)
    order by coalesce(deleted_at, used_at, expires_at), id limit 100
  );
  get diagnostics changed = row_count; purged := purged + changed;
  delete from public.telegram_session_rate_limits
  where last_attempt_at < cutoff;
  get diagnostics changed = row_count; purged := purged + changed;
  return purged;
end;
$$;

revoke all on function private.purge_deleted_records_at(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.purge_deleted_records()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  select private.purge_deleted_records_at(clock_timestamp())
$$;

revoke all on function public.purge_deleted_records() from public, anon, authenticated;
grant execute on function public.purge_deleted_records() to service_role;
