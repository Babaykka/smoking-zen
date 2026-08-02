-- Close stale cleanup leases, make first-arm idempotent under a global path race,
-- retire expired quarantines without deleting their late-write guard, and keep the
-- database Safe predicate in lockstep with the application scanner.

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
  observed_at timestamptz := clock_timestamp();
  first_sweep_at timestamptz;
  guard_until timestamptz;
begin
  if p_ready_path <> p_attachment_id::text then
    raise exception 'attachment_ready_path_invalid' using errcode = '22023';
  end if;

  -- The path is globally unique. Lock and validate it before taking the
  -- attachment lock so every lifecycle function preserves the same order.
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

  first_sweep_at := greatest(observed_at, attachment.quarantine_expires_at);
  guard_until := first_sweep_at + interval '24 hours';

  if guard.id is null then
    insert into public.file_cleanup_queue (
      workspace_id, attachment_id, storage_path, remove_after, retain_until
    ) values (
      p_workspace_id, p_attachment_id, p_ready_path, first_sweep_at, guard_until
    )
    on conflict (storage_path) do nothing
    returning * into guard;

    -- A concurrent first caller may have installed the same guard. Re-read the
    -- winning row and validate its complete scope before returning its UUID.
    if guard.id is null then
      select * into guard
      from public.file_cleanup_queue
      where storage_path = p_ready_path
      for update;

      if guard.id is null or (
        guard.workspace_id is distinct from p_workspace_id
        or guard.attachment_id is distinct from p_attachment_id
      ) then
        raise exception 'attachment_cleanup_guard_scope_conflict' using errcode = '40001';
      end if;
    end if;
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
  observed_at timestamptz := clock_timestamp();
begin
  -- An expired token is stale even if no replacement worker has claimed the row
  -- yet. It must neither delete nor re-arm the authoritative tombstone.
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id
    and lease_id = p_lease_id
    and lease_expires_at > observed_at
  for update;
  if not found then return false; end if;

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

revoke all on function public.finish_file_cleanup_object(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_file_cleanup_object(uuid, uuid) to service_role;

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
  attachment public.attachments%rowtype;
  guard public.file_cleanup_queue%rowtype;
  observed_at timestamptz := clock_timestamp();
begin
  -- Lock any existing cleanup row before its attachment, matching all other
  -- lifecycle RPCs. A rejected scope can never reach an external delete.
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
  if attachment.state <> 'quarantine' then
    raise exception 'attachment_retire_invalid_state' using errcode = '55000';
  end if;
  if attachment.storage_path is distinct from p_expected_storage_path then
    raise exception 'attachment_retire_path_conflict' using errcode = '40001';
  end if;
  if attachment.quarantine_expires_at is null
    or attachment.quarantine_expires_at > observed_at
  then
    raise exception 'attachment_retire_not_expired' using errcode = '55000';
  end if;

  if attachment.deleted_at is null then
    update public.attachments
    set deleted_at = observed_at
    where workspace_id = p_workspace_id and id = p_attachment_id;
  end if;

  -- Publish durable object work in the same transaction as soft retirement.
  -- Storage is touched only after this database-clock authorization commits.
  if guard.id is null then
    insert into public.file_cleanup_queue (
      workspace_id, attachment_id, storage_path, remove_after,
      retain_until, lease_id, lease_expires_at
    ) values (
      p_workspace_id, p_attachment_id, p_expected_storage_path, observed_at,
      null, null, null
    )
    on conflict (storage_path) do nothing
    returning * into guard;

    if guard.id is null then
      select * into guard
      from public.file_cleanup_queue
      where storage_path = p_expected_storage_path
      for update;
    end if;
  end if;

  if guard.id is null or (
    guard.workspace_id is distinct from p_workspace_id
    or guard.attachment_id is distinct from p_attachment_id
  ) then
    raise exception 'attachment_retire_path_conflict' using errcode = '40001';
  end if;

  update public.file_cleanup_queue
  set remove_after = case
    when lease_id is not null and lease_expires_at > observed_at then remove_after
    else least(remove_after, observed_at)
  end
  where id = guard.id;

  return true;
end;
$$;

revoke all on function public.retire_expired_quarantine_attachment(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.retire_expired_quarantine_attachment(uuid, uuid, text)
  to service_role;

alter table public.secure_items drop constraint if exists secure_items_fixed_fields_check;
alter table public.secure_items drop constraint if exists secure_items_external_url_safe_check;

create or replace function private.secure_item_normalize(value text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select translate(normalize(value, NFKC), U&'\200B\200C\200D\2060\FEFF', '')
$$;

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
    '[[:space:]]+',
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
    scanned ~* '(^|[^[:alnum:]])(password|passphrase|secret|token|credential|pin|cvv|cvc|otp|confirmation([ /]+code)?|пароль|секрет|токен|пин|(код[ /]*)?подтвержден[[:alpha:]]*)( */+ *[^[:space:]]+|[[:space:]]+[^[:space:]]*([0-9]|[/~])[^[:space:]]*)'
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
  if value !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?([/?#][^[:space:]]*)?$' then
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

revoke all on function private.secure_item_normalize(text) from public, anon, authenticated;
revoke all on function private.secure_item_scan_text(text) from public, anon, authenticated;
revoke all on function private.secure_item_text_is_safe(text) from public, anon, authenticated;
revoke all on function private.secure_item_url_is_safe(text) from public, anon, authenticated;
grant execute on function private.secure_item_normalize(text) to service_role;
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
