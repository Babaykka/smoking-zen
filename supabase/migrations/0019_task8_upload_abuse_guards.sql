-- Bound signed-upload reservations and serialize server-side file validation.

alter table public.attachments
  add column if not exists validation_lease_id uuid;
alter table public.attachments
  add column if not exists validation_lease_expires_at timestamptz;

update public.attachments
set validation_lease_id = null, validation_lease_expires_at = null
where state = 'ready'
  or num_nonnulls(validation_lease_id, validation_lease_expires_at) not in (0, 2);

alter table public.attachments
  drop constraint if exists attachments_validation_lease_check;
alter table public.attachments
  add constraint attachments_validation_lease_check check (
    (validation_lease_id is null and validation_lease_expires_at is null)
    or (
      state = 'quarantine'
      and validation_lease_id is not null
      and validation_lease_expires_at is not null
    )
  );

create index if not exists attachments_upload_workspace_window_idx
  on public.attachments (workspace_id, created_at);
create index if not exists attachments_upload_member_window_idx
  on public.attachments (workspace_id, created_by, created_at)
  where created_by is not null;

create or replace function public.reserve_attachment_upload(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_task_id uuid,
  p_knowledge_item_id uuid,
  p_created_by uuid,
  p_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_storage_path text
)
returns setof public.attachments
language plpgsql
security definer
set search_path = ''
as $$
declare
  observed_at timestamptz;
  workspace_count bigint;
  member_count bigint;
  reserved public.attachments%rowtype;
begin
  if p_workspace_id is null
    or p_attachment_id is null
    or p_created_by is null
    or p_name is null
    or p_mime_type is null
    or p_size_bytes is null
    or p_storage_path is null
    or num_nonnulls(p_task_id, p_knowledge_item_id) <> 1
  then
    raise exception 'upload_reservation_invalid' using errcode = '22023';
  end if;

  -- One short workspace-row lock makes both rolling-window checks and the insert
  -- atomic without an in-memory or single-instance limiter.
  perform id from public.workspaces
  where id = p_workspace_id and deleted_at is null
  for update;
  if not found then
    raise exception 'upload_parent_not_found' using errcode = 'P0002';
  end if;
  observed_at := clock_timestamp();

  if not exists (
    select 1
    from public.workspace_members as member
    join public.app_users as app_user on app_user.id = member.user_id
    where member.workspace_id = p_workspace_id
      and member.user_id = p_created_by
      and member.active
      and member.deleted_at is null
      and app_user.deleted_at is null
  ) then
    raise exception 'upload_member_not_found' using errcode = 'P0002';
  end if;

  if p_task_id is not null and not exists (
    select 1 from public.tasks
    where workspace_id = p_workspace_id and id = p_task_id and deleted_at is null
  ) then
    raise exception 'upload_parent_not_found' using errcode = 'P0002';
  end if;
  if p_knowledge_item_id is not null and not exists (
    select 1 from public.knowledge_items
    where workspace_id = p_workspace_id and id = p_knowledge_item_id and deleted_at is null
  ) then
    raise exception 'upload_parent_not_found' using errcode = 'P0002';
  end if;

  select count(*)
  into workspace_count
  from public.attachments
  where workspace_id = p_workspace_id
    and created_at >= observed_at - interval '1 hour';
  if workspace_count >= 100 then
    raise exception 'upload_workspace_quota_exceeded' using errcode = '54000';
  end if;
  if (workspace_count + 1) * 26214400 > 1073741824 then
    raise exception 'upload_workspace_byte_quota_exceeded' using errcode = '54000';
  end if;

  select count(*)
  into member_count
  from public.attachments
  where workspace_id = p_workspace_id
    and created_by = p_created_by
    and created_at >= observed_at - interval '1 hour';
  if member_count >= 12 then
    raise exception 'upload_member_quota_exceeded' using errcode = '54000';
  end if;
  if (member_count + 1) * 26214400 > 262144000 then
    raise exception 'upload_member_byte_quota_exceeded' using errcode = '54000';
  end if;

  insert into public.attachments (
    id, workspace_id, task_id, knowledge_item_id, name, mime_type,
    size_bytes, storage_path, state, sha256, created_by,
    quarantine_expires_at, completed_at, created_at
  ) values (
    p_attachment_id, p_workspace_id, p_task_id, p_knowledge_item_id, p_name, p_mime_type,
    p_size_bytes, p_storage_path, 'quarantine', null, p_created_by,
    observed_at + interval '125 minutes', null, observed_at
  )
  returning * into reserved;

  return next reserved;
end;
$$;

revoke all on function public.reserve_attachment_upload(uuid, uuid, uuid, uuid, uuid, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.reserve_attachment_upload(uuid, uuid, uuid, uuid, uuid, text, text, bigint, text)
  to service_role;

create or replace function public.cancel_attachment_upload_reservation(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_storage_path text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  attachment public.attachments%rowtype;
  observed_at timestamptz;
begin
  if p_workspace_id is null or p_attachment_id is null or p_expected_storage_path is null then
    raise exception 'upload_reservation_cancel_invalid' using errcode = '22023';
  end if;
  select * into attachment
  from public.attachments
  where workspace_id = p_workspace_id and id = p_attachment_id
  for update;
  if not found then
    raise exception 'upload_reservation_not_found' using errcode = 'P0002';
  end if;
  if attachment.state <> 'quarantine'
    or attachment.storage_path is distinct from p_expected_storage_path
    or attachment.validation_lease_id is not null
  then
    raise exception 'upload_reservation_cancel_conflict' using errcode = '40001';
  end if;
  observed_at := clock_timestamp();
  update public.attachments
  set deleted_at = coalesce(deleted_at, observed_at)
  where workspace_id = p_workspace_id and id = p_attachment_id;
  perform private.ensure_quarantine_cleanup_guard(
    p_workspace_id, p_attachment_id, p_expected_storage_path, observed_at
  );
  return true;
end;
$$;

revoke all on function public.cancel_attachment_upload_reservation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_attachment_upload_reservation(uuid, uuid, text)
  to service_role;

create or replace function public.claim_attachment_validation(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_storage_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  attachment public.attachments%rowtype;
  observed_at timestamptz;
  claimed_lease uuid;
begin
  if p_workspace_id is null or p_attachment_id is null or p_expected_storage_path is null then
    raise exception 'attachment_validation_request_invalid' using errcode = '22023';
  end if;

  -- Cleanup and validation share one global order across both the uploaded
  -- quarantine object and the deterministic future-ready object.
  perform id
  from public.file_cleanup_queue
  where storage_path in (p_expected_storage_path, p_attachment_id::text)
  order by storage_path
  for update;
  if exists (
    select 1 from public.file_cleanup_queue
    where storage_path in (p_expected_storage_path, p_attachment_id::text)
      and (
        workspace_id is distinct from p_workspace_id
        or attachment_id is distinct from p_attachment_id
      )
  ) then
    raise exception 'attachment_validation_not_found' using errcode = 'P0002';
  end if;

  select * into attachment
  from public.attachments
  where workspace_id = p_workspace_id and id = p_attachment_id
  for update;
  if not found
    or attachment.state <> 'quarantine'
    or attachment.storage_path is distinct from p_expected_storage_path
    or attachment.deleted_at is not null
  then
    raise exception 'attachment_validation_not_found' using errcode = 'P0002';
  end if;
  observed_at := clock_timestamp();
  if exists (
    select 1 from public.file_cleanup_queue
    where storage_path in (p_expected_storage_path, p_attachment_id::text)
      and lease_id is not null
      and lease_expires_at > observed_at
  ) then
    return null;
  end if;
  if attachment.quarantine_expires_at is null
    or attachment.quarantine_expires_at <= observed_at
  then
    raise exception 'attachment_validation_expired' using errcode = '55000';
  end if;

  if attachment.validation_lease_id is not null
    and attachment.validation_lease_expires_at > observed_at
  then
    return null;
  end if;

  claimed_lease := extensions.gen_random_uuid();
  update public.attachments
  set validation_lease_id = claimed_lease,
    validation_lease_expires_at = observed_at + interval '10 minutes'
  where workspace_id = p_workspace_id and id = p_attachment_id;
  return claimed_lease;
end;
$$;

revoke all on function public.claim_attachment_validation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_attachment_validation(uuid, uuid, text)
  to service_role;

create or replace function public.release_attachment_validation(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_storage_path text,
  p_validation_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if p_validation_lease_id is null then
    raise exception 'attachment_validation_lease_required' using errcode = '22023';
  end if;
  update public.attachments
  set validation_lease_id = null, validation_lease_expires_at = null
  where workspace_id = p_workspace_id
    and id = p_attachment_id
    and state = 'quarantine'
    and storage_path = p_expected_storage_path
    and validation_lease_id = p_validation_lease_id;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.release_attachment_validation(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_attachment_validation(uuid, uuid, text, uuid)
  to service_role;

create or replace function private.retire_quarantine_attachment_authorized(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_storage_path text,
  p_reason text,
  p_validation_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  attachment public.attachments%rowtype;
  guard public.file_cleanup_queue%rowtype;
  observed_at timestamptz;
  parent_is_live boolean;
begin
  if p_reason is null or p_reason not in ('expired', 'parent_missing', 'invalid_content') then
    raise exception 'attachment_retire_reason_invalid' using errcode = '22023';
  end if;
  if p_reason <> 'expired' and p_validation_lease_id is null then
    raise exception 'validation_lease_required' using errcode = '22023';
  end if;

  select * into guard
  from public.file_cleanup_queue
  where storage_path = p_expected_storage_path
  for update;
  if guard.id is not null and (
    guard.workspace_id is distinct from p_workspace_id
    or guard.attachment_id is distinct from p_attachment_id
  ) then
    if not exists (
      select 1 from public.attachments
      where workspace_id = p_workspace_id and id = p_attachment_id
    ) then
      raise exception 'attachment_retire_not_found' using errcode = 'P0002';
    end if;
    raise exception 'attachment_retire_path_conflict' using errcode = '40001';
  end if;

  select * into attachment
  from public.attachments
  where workspace_id = p_workspace_id and id = p_attachment_id
  for update;
  if not found then
    raise exception 'attachment_retire_not_found' using errcode = 'P0002';
  end if;
  observed_at := clock_timestamp();
  if attachment.state <> 'quarantine' then
    raise exception 'attachment_retire_invalid_state' using errcode = '55000';
  end if;
  if attachment.storage_path is distinct from p_expected_storage_path then
    raise exception 'attachment_retire_path_conflict' using errcode = '40001';
  end if;
  if attachment.quarantine_expires_at is null then
    raise exception 'attachment_retire_expiry_missing' using errcode = '55000';
  end if;

  if p_reason = 'expired' then
    if attachment.quarantine_expires_at > observed_at then return false; end if;
    if attachment.validation_lease_id is not null
      and attachment.validation_lease_expires_at > observed_at
    then
      return false;
    end if;
  elsif attachment.validation_lease_id is distinct from p_validation_lease_id
    or attachment.validation_lease_expires_at is null
    or attachment.validation_lease_expires_at <= observed_at
  then
    raise exception 'attachment_validation_lease_invalid' using errcode = '40001';
  end if;

  parent_is_live := (
    attachment.task_id is not null and exists (
      select 1 from public.tasks as parent
      where parent.workspace_id = p_workspace_id
        and parent.id = attachment.task_id and parent.deleted_at is null
    )
  ) or (
    attachment.knowledge_item_id is not null and exists (
      select 1 from public.knowledge_items as parent
      where parent.workspace_id = p_workspace_id
        and parent.id = attachment.knowledge_item_id and parent.deleted_at is null
    )
  );
  if p_reason = 'parent_missing' and parent_is_live then
    raise exception 'attachment_retire_parent_exists' using errcode = '55000';
  end if;

  update public.attachments
  set deleted_at = coalesce(deleted_at, observed_at),
    validation_lease_id = null,
    validation_lease_expires_at = null
  where workspace_id = p_workspace_id and id = p_attachment_id;
  perform private.ensure_quarantine_cleanup_guard(
    p_workspace_id, p_attachment_id, p_expected_storage_path,
    greatest(observed_at, attachment.quarantine_expires_at)
  );
  return true;
end;
$$;

revoke all on function private.retire_quarantine_attachment_authorized(uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.retire_quarantine_attachment(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_storage_path text,
  p_reason text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.retire_quarantine_attachment_authorized(
    p_workspace_id, p_attachment_id, p_expected_storage_path, p_reason, null
  )
$$;

create or replace function public.retire_quarantine_attachment(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_storage_path text,
  p_reason text,
  p_validation_lease_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.retire_quarantine_attachment_authorized(
    p_workspace_id, p_attachment_id, p_expected_storage_path, p_reason, p_validation_lease_id
  )
$$;

revoke all on function public.retire_quarantine_attachment(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.retire_quarantine_attachment(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.retire_quarantine_attachment(uuid, uuid, text, text)
  to service_role;
grant execute on function public.retire_quarantine_attachment(uuid, uuid, text, text, uuid)
  to service_role;

create or replace function public.complete_attachment_upload(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_quarantine_path text,
  p_ready_path text,
  p_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_sha256 text,
  p_validation_lease_id uuid
)
returns setof public.attachments
language plpgsql
security definer
set search_path = ''
as $$
declare
  attachment public.attachments%rowtype;
  completed public.attachments%rowtype;
  ready_guard public.file_cleanup_queue%rowtype;
  quarantine_guard public.file_cleanup_queue%rowtype;
  observed_at timestamptz;
  original_quarantine_expiry timestamptz;
  parent_is_live boolean;
begin
  if p_validation_lease_id is null then
    raise exception 'attachment_validation_lease_invalid' using errcode = '40001';
  end if;
  if p_ready_path <> p_attachment_id::text
    or p_expected_quarantine_path = p_ready_path
  then
    raise exception 'attachment_ready_path_invalid' using errcode = '22023';
  end if;

  perform id from public.file_cleanup_queue
  where storage_path in (p_expected_quarantine_path, p_ready_path)
  order by storage_path for update;

  select * into ready_guard from public.file_cleanup_queue where storage_path = p_ready_path;
  if ready_guard.id is null
    or ready_guard.workspace_id is distinct from p_workspace_id
    or ready_guard.attachment_id is distinct from p_attachment_id
  then
    raise exception 'attachment_cleanup_guard_missing' using errcode = '40001';
  end if;
  if ready_guard.lease_id is not null then
    raise exception 'attachment_cleanup_in_progress' using errcode = '40001';
  end if;

  select * into quarantine_guard
  from public.file_cleanup_queue where storage_path = p_expected_quarantine_path;
  if quarantine_guard.id is not null and (
    quarantine_guard.workspace_id is distinct from p_workspace_id
    or quarantine_guard.attachment_id is distinct from p_attachment_id
  ) then
    raise exception 'attachment_quarantine_guard_scope_conflict' using errcode = '40001';
  end if;

  select * into attachment
  from public.attachments
  where workspace_id = p_workspace_id and id = p_attachment_id
  for update;
  observed_at := clock_timestamp();
  if not found
    or attachment.state <> 'quarantine'
    or attachment.storage_path is distinct from p_expected_quarantine_path
    or attachment.deleted_at is not null
    or attachment.quarantine_expires_at is null
  then
    raise exception 'attachment_completion_conflict' using errcode = '40001';
  end if;
  if attachment.validation_lease_id is distinct from p_validation_lease_id
    or attachment.validation_lease_expires_at is null
    or attachment.validation_lease_expires_at <= observed_at
  then
    raise exception 'attachment_validation_lease_invalid' using errcode = '40001';
  end if;
  if attachment.quarantine_expires_at <= observed_at then
    raise exception 'attachment_completion_conflict' using errcode = '40001';
  end if;

  parent_is_live := (
    attachment.task_id is not null and exists (
      select 1 from public.tasks as parent where parent.workspace_id = p_workspace_id
        and parent.id = attachment.task_id and parent.deleted_at is null
    )
  ) or (
    attachment.knowledge_item_id is not null and exists (
      select 1 from public.knowledge_items as parent where parent.workspace_id = p_workspace_id
        and parent.id = attachment.knowledge_item_id and parent.deleted_at is null
    )
  );
  if not parent_is_live then
    raise exception 'attachment_completion_conflict' using errcode = '40001';
  end if;

  original_quarantine_expiry := attachment.quarantine_expires_at;
  update public.attachments
  set name = p_name,
    mime_type = p_mime_type,
    size_bytes = p_size_bytes,
    storage_path = p_ready_path,
    storage_layout = 'opaque',
    state = 'ready',
    sha256 = p_sha256,
    completed_at = observed_at,
    quarantine_expires_at = null,
    validation_lease_id = null,
    validation_lease_expires_at = null
  where workspace_id = p_workspace_id and id = p_attachment_id
  returning * into completed;

  delete from public.file_cleanup_queue where id = ready_guard.id;
  perform private.ensure_quarantine_cleanup_guard(
    p_workspace_id, p_attachment_id, p_expected_quarantine_path,
    greatest(observed_at, original_quarantine_expiry)
  );
  return next completed;
end;
$$;

drop function if exists public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text);
revoke all on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text, uuid)
  to service_role;

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

  with candidates as (
    select workspace_id, id
    from public.attachments
    where state = 'quarantine'
      and deleted_at is null
      and quarantine_expires_at <= p_observed_at
      and (validation_lease_id is null or validation_lease_expires_at <= p_observed_at)
    order by quarantine_expires_at, id
    limit 100
    for update skip locked
  )
  update public.attachments as attachment
  set deleted_at = p_observed_at,
    validation_lease_id = null,
    validation_lease_expires_at = null
  from candidates as candidate
  where attachment.workspace_id = candidate.workspace_id and attachment.id = candidate.id;
  get diagnostics changed = row_count;
  affected := affected + changed;

  insert into public.file_cleanup_queue (
    workspace_id, attachment_id, storage_path, remove_after, retain_until
  )
  select attachment.workspace_id, attachment.id, attachment.storage_path,
    attachment.deleted_at + interval '30 days', null
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
  select attachment.workspace_id, attachment.id, attachment.storage_path,
    greatest(attachment.quarantine_expires_at, p_observed_at),
    greatest(attachment.quarantine_expires_at, p_observed_at) + interval '24 hours'
  from public.attachments as attachment
  where attachment.state = 'quarantine'
    and attachment.deleted_at is not null
    and attachment.quarantine_cleanup_completed_at is null
    and attachment.quarantine_expires_at is not null
    and (
      attachment.validation_lease_id is null
      or attachment.validation_lease_expires_at <= p_observed_at
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
  return affected;
end;
$$;

revoke all on function private.stage_file_cleanup_at(timestamptz)
  from public, anon, authenticated, service_role;

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

    if found
      and attachment.state = 'quarantine'
      and attachment.validation_lease_id is not null
      and attachment.validation_lease_expires_at > observed_at
    then
      update public.file_cleanup_queue
      set remove_after = greatest(remove_after, attachment.validation_lease_expires_at),
        retain_until = greatest(
          coalesce(retain_until, attachment.validation_lease_expires_at + interval '24 hours'),
          attachment.validation_lease_expires_at + interval '24 hours'
        ),
        lease_id = null,
        lease_expires_at = null
      where id = candidate.id;
      return null;
    end if;

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

alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

-- Re-establish only the private helper surface needed by the protected
-- Realtime policy and service-side validation after 0018's blanket revoke.
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

-- Hosted Storage normally enables RLS, but keep restored/self-hosted projects
-- fail-closed instead of relying on provider bootstrap state.
alter table storage.objects enable row level security;
