-- Make retained cleanup progress explicit and keep Safe URL validation aligned.

alter table public.file_cleanup_queue
  add column if not exists first_remove_succeeded_at timestamptz;

alter table public.file_cleanup_queue
  drop constraint if exists file_cleanup_queue_first_remove_success_check;
alter table public.file_cleanup_queue
  add constraint file_cleanup_queue_first_remove_success_check check (
    first_remove_succeeded_at is null
    or (
      retain_until is not null
      and remove_after >= first_remove_succeeded_at + interval '24 hours'
      and retain_until >= first_remove_succeeded_at + interval '24 hours'
    )
  );

-- A retained queue row represents one immutable signed path. Once its first
-- successful Storage removal is recorded, retries and lifecycle convergence
-- must leave that anchor and its scheduled second sweep untouched.
create or replace function private.ensure_quarantine_cleanup_guard(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_storage_path text,
  p_first_sweep_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  guard public.file_cleanup_queue%rowtype;
  observed_at timestamptz;
begin
  select * into guard
  from public.file_cleanup_queue
  where storage_path = p_storage_path
  for update;

  if guard.id is not null and (
    guard.workspace_id is distinct from p_workspace_id
    or guard.attachment_id is distinct from p_attachment_id
  ) then
    raise exception 'attachment_quarantine_guard_scope_conflict' using errcode = '40001';
  end if;

  if guard.id is null then
    insert into public.file_cleanup_queue (
      workspace_id, attachment_id, storage_path, remove_after, retain_until
    ) values (
      p_workspace_id, p_attachment_id, p_storage_path,
      p_first_sweep_at, p_first_sweep_at + interval '24 hours'
    )
    on conflict (storage_path) do nothing
    returning * into guard;

    if guard.id is null then
      select * into guard
      from public.file_cleanup_queue
      where storage_path = p_storage_path
      for update;
    end if;
  end if;

  if guard.id is null or (
    guard.workspace_id is distinct from p_workspace_id
    or guard.attachment_id is distinct from p_attachment_id
  ) then
    raise exception 'attachment_quarantine_guard_scope_conflict' using errcode = '40001';
  end if;

  if guard.first_remove_succeeded_at is not null then
    return guard.id;
  end if;

  observed_at := clock_timestamp();
  update public.file_cleanup_queue
  set
    remove_after = case
      when retain_until is not null then remove_after
      when lease_id is not null and lease_expires_at > observed_at then remove_after
      else greatest(remove_after, p_first_sweep_at)
    end,
    retain_until = case
      when retain_until is not null then retain_until
      else greatest(remove_after, p_first_sweep_at) + interval '24 hours'
    end,
    lease_id = case
      when lease_id is not null and lease_expires_at > observed_at then lease_id
      else null
    end,
    lease_expires_at = case
      when lease_id is not null and lease_expires_at > observed_at then lease_expires_at
      else null
    end
  where id = guard.id
  returning * into guard;

  return guard.id;
end;
$$;

revoke all on function private.ensure_quarantine_cleanup_guard(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function private.ensure_quarantine_cleanup_guard(uuid, uuid, text, timestamptz)
  to service_role;

-- Recover retired quarantine paths whose old 0013 finish already deleted the
-- only queue row. Runtime discovery intentionally ignores soft-deleted metadata,
-- so upgrade convergence must restore these guards directly from durable rows.
-- The helper preserves an existing guard's scope, live lease, retained schedule,
-- and explicit first-success anchor; reapplication therefore cannot move them.
do $backfill_retired_quarantine_guards$
declare
  candidate record;
begin
  for candidate in
    select workspace_id, id as attachment_id, storage_path,
      greatest(clock_timestamp(), quarantine_expires_at) as first_sweep_at
    from public.attachments
    where state = 'quarantine'
      and deleted_at is not null
      and storage_path is not null
      and quarantine_expires_at is not null
    order by storage_path
  loop
    perform private.ensure_quarantine_cleanup_guard(
      candidate.workspace_id,
      candidate.attachment_id,
      candidate.storage_path,
      candidate.first_sweep_at
    );
  end loop;

  -- A ready row no longer stores its randomized quarantine key. If an older
  -- cleanup already erased that key's queue row, no deployed durable relation
  -- remains from which this migration could reconstruct it safely.
end;
$backfill_retired_quarantine_guards$;

-- A successful finish is the durable acknowledgement that Storage removal
-- completed. Every retained row records that first acknowledgement and schedules
-- a second sweep at the later of its existing anchor and 24 hours from reality.
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
  observed_at timestamptz;
  second_sweep_at timestamptz;
begin
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id and lease_id = p_lease_id
  for update;
  if not found then return false; end if;

  observed_at := clock_timestamp();
  if candidate.lease_expires_at is null
    or candidate.lease_expires_at <= observed_at
  then
    return false;
  end if;

  if candidate.retain_until is not null
    and candidate.first_remove_succeeded_at is null
  then
    second_sweep_at := greatest(
      candidate.retain_until,
      observed_at + interval '24 hours'
    );
    update public.file_cleanup_queue
    set
      first_remove_succeeded_at = observed_at,
      remove_after = second_sweep_at,
      retain_until = second_sweep_at,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null
    where id = candidate.id;
    return false;
  end if;

  delete from public.file_cleanup_queue where id = candidate.id;
  return true;
end;
$$;

revoke all on function public.finish_file_cleanup_object(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_file_cleanup_object(uuid, uuid)
  to service_role;

-- NULL must not slip through SQL's three-valued NOT IN predicate and authorize
-- retirement without a real lifecycle reason.
create or replace function public.retire_quarantine_attachment(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_storage_path text,
  p_reason text
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
  if p_reason is null
    or p_reason not in ('expired', 'parent_missing', 'invalid_content')
  then
    raise exception 'attachment_retire_reason_invalid' using errcode = '22023';
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

  if p_reason = 'expired' and attachment.quarantine_expires_at > observed_at then
    return false;
  end if;

  parent_is_live := (
    attachment.task_id is not null and exists (
      select 1 from public.tasks as parent
      where parent.workspace_id = p_workspace_id
        and parent.id = attachment.task_id
        and parent.deleted_at is null
    )
  ) or (
    attachment.knowledge_item_id is not null and exists (
      select 1 from public.knowledge_items as parent
      where parent.workspace_id = p_workspace_id
        and parent.id = attachment.knowledge_item_id
        and parent.deleted_at is null
    )
  );

  if p_reason = 'parent_missing' and parent_is_live then
    raise exception 'attachment_retire_parent_exists' using errcode = '55000';
  end if;

  if attachment.deleted_at is null then
    update public.attachments
    set deleted_at = observed_at
    where workspace_id = p_workspace_id and id = p_attachment_id;
  end if;

  perform private.ensure_quarantine_cleanup_guard(
    p_workspace_id,
    p_attachment_id,
    p_expected_storage_path,
    greatest(observed_at, attachment.quarantine_expires_at)
  );
  return true;
end;
$$;

revoke all on function public.retire_quarantine_attachment(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.retire_quarantine_attachment(uuid, uuid, text, text)
  to service_role;

-- Reject raw ECMAScript whitespace before URL parsing in both runtimes. Encoded
-- benign characters still pass through the existing bounded decoder and scanner.
alter table public.secure_items
  drop constraint if exists secure_items_external_url_safe_check;

create or replace function private.secure_item_url_is_safe(value text)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  decoded_remainder text;
  normalized_remainder text;
  scanned_remainder text;
  query_part text;
begin
  if value is null then return true; end if;
  if value ~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' then
    return false;
  end if;
  if value !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?([/?#].*)?$' then
    return false;
  end if;

  decoded_remainder := private.percent_decode_url_component(
    regexp_replace(value, '^https://[^/?#]+', '')
  );
  if decoded_remainder is null then return false; end if;
  normalized_remainder := private.secure_item_normalize(decoded_remainder);

  scanned_remainder := regexp_replace(
    normalized_remainder,
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
    '',
    'gi'
  );
  if not private.secure_item_text_is_safe(scanned_remainder) then return false; end if;

  if position('?' in normalized_remainder) > 0 then
    query_part := split_part(split_part(normalized_remainder, '?', 2), '#', 1);
    if query_part ~* '(^|&)[^=&]*(token|signature|credential|secret|password|passphrase|pin|cvv|cvc|otp|confirmation|x-amz-)[^=&]*(=|&|$)' then
      return false;
    end if;
  end if;
  return true;
end;
$$;

revoke all on function private.secure_item_url_is_safe(text)
  from public, anon, authenticated;
grant execute on function private.secure_item_url_is_safe(text)
  to service_role;

update public.secure_items
set external_url = 'https://vault.bitwarden.com/'
where not private.secure_item_url_is_safe(external_url);

alter table public.secure_items
  add constraint secure_items_external_url_safe_check check (
    char_length(external_url) between 9 and 2000
    and private.secure_item_url_is_safe(external_url)
  );
