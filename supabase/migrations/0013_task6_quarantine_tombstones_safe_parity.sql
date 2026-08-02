-- Retain every signed-upload quarantine path through a second removal window and
-- keep Safe canonicalization identical in the application and database.

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

  observed_at := clock_timestamp();
  update public.file_cleanup_queue
  set
    remove_after = case
      -- A retained row already represents this one immutable signed path. Do not
      -- extend it on idempotent retries or migration reapplication.
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

-- Backfill live and soft-deleted quarantine rows. A signed URL may still commit
-- after its metadata was retired, so every path gets a retained two-remove guard.
do $backfill_quarantine_guards$
declare
  candidate record;
begin
  for candidate in
    select workspace_id, id as attachment_id, storage_path,
      greatest(clock_timestamp(), quarantine_expires_at) as first_sweep_at
    from public.attachments
    where state = 'quarantine' and quarantine_expires_at is not null
    order by storage_path
  loop
    perform private.ensure_quarantine_cleanup_guard(
      candidate.workspace_id, candidate.attachment_id,
      candidate.storage_path, candidate.first_sweep_at
    );
  end loop;

  -- Older completion RPCs erased quarantine_expires_at. Their surviving queue
  -- row still identifies the old path; created_at + 125 minutes is the original
  -- signed-upload window and is the conservative migration-time lower bound.
  for candidate in
    select attachment.workspace_id, attachment.id as attachment_id,
      cleanup.storage_path,
      greatest(clock_timestamp(), attachment.created_at + interval '125 minutes') as first_sweep_at
    from public.attachments as attachment
    join public.file_cleanup_queue as cleanup
      on cleanup.workspace_id = attachment.workspace_id
     and cleanup.attachment_id = attachment.id
    where attachment.state = 'ready'
      and cleanup.storage_path is distinct from attachment.storage_path
    order by cleanup.storage_path
  loop
    perform private.ensure_quarantine_cleanup_guard(
      candidate.workspace_id, candidate.attachment_id,
      candidate.storage_path, candidate.first_sweep_at
    );
  end loop;
end;
$backfill_quarantine_guards$;

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
  if p_reason not in ('expired', 'parent_missing', 'invalid_content') then
    raise exception 'attachment_retire_reason_invalid' using errcode = '22023';
  end if;

  -- Every lifecycle RPC locks a globally unique object guard before its row.
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

-- Keep the old callable compatible, but route it through the same retained
-- database-clock protocol so no legacy caller can create a one-remove Q row.
create or replace function public.retire_expired_quarantine_attachment(
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
  retired boolean;
begin
  retired := public.retire_quarantine_attachment(
    p_workspace_id, p_attachment_id, p_expected_storage_path, 'expired'
  );
  if not retired then
    raise exception 'attachment_retire_not_expired' using errcode = '55000';
  end if;
  return true;
end;
$$;

revoke all on function public.retire_expired_quarantine_attachment(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.retire_expired_quarantine_attachment(uuid, uuid, text)
  to service_role;

create or replace function public.arm_attachment_ready_cleanup(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_ready_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  attachment public.attachments%rowtype;
  guard public.file_cleanup_queue%rowtype;
  observed_at timestamptz;
  first_sweep_at timestamptz;
  guard_until timestamptz;
  inserted_guard boolean := false;
begin
  if p_ready_path <> p_attachment_id::text then
    raise exception 'attachment_ready_path_invalid' using errcode = '22023';
  end if;

  select * into guard
  from public.file_cleanup_queue
  where storage_path = p_ready_path
  for update;

  if guard.id is not null and (
    guard.workspace_id is distinct from p_workspace_id
    or guard.attachment_id is distinct from p_attachment_id
  ) then
    raise exception 'attachment_cleanup_guard_scope_conflict' using errcode = '40001';
  end if;

  select * into attachment
  from public.attachments
  where workspace_id = p_workspace_id and id = p_attachment_id
  for update;

  if not found
    or attachment.state <> 'quarantine'
    or attachment.quarantine_expires_at is null
    or attachment.deleted_at is not null
  then
    raise exception 'attachment_cleanup_guard_conflict' using errcode = '40001';
  end if;

  first_sweep_at := attachment.quarantine_expires_at;
  guard_until := first_sweep_at + interval '24 hours';

  if guard.id is null then
    insert into public.file_cleanup_queue (
      workspace_id, attachment_id, storage_path, remove_after, retain_until
    ) values (
      p_workspace_id, p_attachment_id, p_ready_path, first_sweep_at, guard_until
    )
    on conflict (storage_path) do nothing
    returning * into guard;

    if guard.id is not null then
      inserted_guard := true;
    else
      select * into guard
      from public.file_cleanup_queue
      where storage_path = p_ready_path
      for update;
    end if;
  end if;

  if guard.id is null or (
    guard.workspace_id is distinct from p_workspace_id
    or guard.attachment_id is distinct from p_attachment_id
  ) then
    raise exception 'attachment_cleanup_guard_scope_conflict' using errcode = '40001';
  end if;

  observed_at := clock_timestamp();
  -- This is the database-clock authorization boundary for an external ready
  -- write. If expiry passed while an insert conflict was blocked, remove only
  -- the guard created by this transaction and refuse the provider write.
  if attachment.quarantine_expires_at <= observed_at then
    if inserted_guard then
      delete from public.file_cleanup_queue where id = guard.id;
    end if;
    return null;
  end if;

  update public.file_cleanup_queue
  set
    remove_after = case
      when lease_id is null or lease_expires_at <= observed_at
        then greatest(remove_after, first_sweep_at)
      else remove_after
    end,
    retain_until = greatest(coalesce(retain_until, guard_until), guard_until),
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

revoke all on function public.arm_attachment_ready_cleanup(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.arm_attachment_ready_cleanup(uuid, uuid, text)
  to service_role;

create or replace function public.complete_attachment_upload(
  p_workspace_id uuid,
  p_attachment_id uuid,
  p_expected_quarantine_path text,
  p_ready_path text,
  p_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_sha256 text
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
  if p_ready_path <> p_attachment_id::text
    or p_expected_quarantine_path = p_ready_path
  then
    raise exception 'attachment_ready_path_invalid' using errcode = '22023';
  end if;

  -- Lock both globally unique paths in one deterministic order, then the source
  -- row. This composes safely with single-path arm and retirement transactions.
  perform id
  from public.file_cleanup_queue
  where storage_path in (p_expected_quarantine_path, p_ready_path)
  order by storage_path
  for update;

  select * into ready_guard
  from public.file_cleanup_queue
  where storage_path = p_ready_path;
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
  from public.file_cleanup_queue
  where storage_path = p_expected_quarantine_path;
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

  if not found
    or attachment.state <> 'quarantine'
    or attachment.storage_path is distinct from p_expected_quarantine_path
    or attachment.deleted_at is not null
    or attachment.quarantine_expires_at is null
  then
    raise exception 'attachment_completion_conflict' using errcode = '40001';
  end if;

  observed_at := clock_timestamp();
  if attachment.quarantine_expires_at <= observed_at then
    raise exception 'attachment_completion_conflict' using errcode = '40001';
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
  if not parent_is_live then
    raise exception 'attachment_completion_conflict' using errcode = '40001';
  end if;

  original_quarantine_expiry := attachment.quarantine_expires_at;
  update public.attachments
  set
    name = p_name,
    mime_type = p_mime_type,
    size_bytes = p_size_bytes,
    storage_path = p_ready_path,
    storage_layout = 'opaque',
    state = 'ready',
    sha256 = p_sha256,
    completed_at = observed_at,
    quarantine_expires_at = null
  where workspace_id = p_workspace_id and id = p_attachment_id
  returning * into completed;

  -- Publishing the ready reference cancels only its ready-path guard. The old
  -- signed quarantine path remains a retained two-remove tombstone.
  delete from public.file_cleanup_queue where id = ready_guard.id;
  perform private.ensure_quarantine_cleanup_guard(
    p_workspace_id,
    p_attachment_id,
    p_expected_quarantine_path,
    greatest(observed_at, original_quarantine_expiry)
  );

  return next completed;
end;
$$;

revoke all on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  to service_role;

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
begin
  -- Match the token and acquire the row first. A worker that waited behind
  -- another transaction must refresh the database clock before it can re-arm
  -- or delete anything with that lease.
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

  if candidate.retain_until is not null and candidate.retain_until > observed_at then
    update public.file_cleanup_queue
    set
      remove_after = candidate.retain_until,
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

-- Canonical Safe parity. Both runtimes use this exact ECMAScript whitespace
-- matrix after NFKC and the same five zero-width removals.
alter table public.secure_items drop constraint if exists secure_items_fixed_fields_check;
alter table public.secure_items drop constraint if exists secure_items_external_url_safe_check;

create or replace function private.secure_item_scan_text(value text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      private.secure_item_normalize(value),
      '[-֊־᐀᠆‐‑‒–—―⸗⸚⸺⸻⹀⹝〜〰゠︱︲﹘﹣－𐵮𐺭+:/_.=]+',
      '/',
      'g'
    ),
    U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+',
    ' ',
    'g'
  )
$$;

create or replace function private.secure_item_text_is_safe(value text)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  scanned text;
begin
  if value is null then return true; end if;
  scanned := private.secure_item_scan_text(value);
  return not (
    scanned ~* '(^|[^[:alnum:]])(password|passphrase|secret|token|credential|pin|cvv|cvc|otp|confirmation([ /]+code)?|пароль|секрет|токен|пин|(код[ /]*)?подтвержден[[:alpha:]]*)( */+ *[^ ]+| +[^ ]*([0-9]|[/~])[^ ]*)'
    or scanned ~ '[0-9]([ /]*[0-9]){12,18}'
  );
end;
$$;

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
  if value ~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]' then
    return false;
  end if;
  if value !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?([/?#].*)?$' then
    return false;
  end if;

  -- Decode the untouched remainder, including the raw query, before splitting
  -- keys and values. Malformed UTF-8/percent escapes and an eighth changing
  -- encoding layer therefore fail identically in SQL and TypeScript.
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

revoke all on function private.secure_item_scan_text(text) from public, anon, authenticated;
revoke all on function private.secure_item_text_is_safe(text) from public, anon, authenticated;
revoke all on function private.secure_item_url_is_safe(text) from public, anon, authenticated;
grant execute on function private.secure_item_scan_text(text) to service_role;
grant execute on function private.secure_item_text_is_safe(text) to service_role;
grant execute on function private.secure_item_url_is_safe(text) to service_role;

update public.secure_items
set
  title = case
    when private.secure_item_text_is_safe(title) then title else 'Безопасная запись'
  end,
  purpose = case
    when private.secure_item_text_is_safe(purpose) then purpose else 'Ссылка на запись в Bitwarden'
  end,
  owner = case
    when private.secure_item_text_is_safe(owner) then owner else 'Команда'
  end,
  card_bank = case
    when private.secure_item_text_is_safe(card_bank) then card_bank else null
  end,
  card_holder = case
    when private.secure_item_text_is_safe(card_holder) then card_holder else null
  end,
  card_purpose = case
    when private.secure_item_text_is_safe(card_purpose) then card_purpose else null
  end,
  external_url = case
    when private.secure_item_url_is_safe(external_url) then external_url
    else 'https://vault.bitwarden.com/'
  end
where not private.secure_item_text_is_safe(title)
  or not private.secure_item_text_is_safe(purpose)
  or not private.secure_item_text_is_safe(owner)
  or not private.secure_item_text_is_safe(card_bank)
  or not private.secure_item_text_is_safe(card_holder)
  or not private.secure_item_text_is_safe(card_purpose)
  or not private.secure_item_url_is_safe(external_url);

alter table public.secure_items
  add constraint secure_items_fixed_fields_check check (
    char_length(trim(purpose)) between 1 and 2000
    and char_length(trim(owner)) between 1 and 280
    and (card_bank is null or char_length(trim(card_bank)) between 1 and 280)
    and (card_holder is null or char_length(trim(card_holder)) between 1 and 280)
    and (card_purpose is null or char_length(trim(card_purpose)) between 1 and 2000)
    and private.secure_item_text_is_safe(title)
    and private.secure_item_text_is_safe(purpose)
    and private.secure_item_text_is_safe(owner)
    and private.secure_item_text_is_safe(card_bank)
    and private.secure_item_text_is_safe(card_holder)
    and private.secure_item_text_is_safe(card_purpose)
  );

alter table public.secure_items
  add constraint secure_items_external_url_safe_check check (
    char_length(external_url) between 9 and 2000
    and private.secure_item_url_is_safe(external_url)
  );
