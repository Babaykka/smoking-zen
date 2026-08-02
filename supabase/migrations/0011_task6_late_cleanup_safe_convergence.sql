-- Keep an authoritative late-write tombstone beyond the provider ambiguity window,
-- and converge every Safe row before installing the matching decoded predicates.

alter table public.file_cleanup_queue add column if not exists retain_until timestamptz;
alter table public.file_cleanup_queue add column if not exists lease_id uuid;
alter table public.file_cleanup_queue add column if not exists lease_expires_at timestamptz;

alter table public.file_cleanup_queue drop constraint if exists file_cleanup_queue_lease_check;
alter table public.file_cleanup_queue
  add constraint file_cleanup_queue_lease_check check (
    (lease_id is null and lease_expires_at is null)
    or (lease_id is not null and lease_expires_at is not null)
  );

-- Existing deterministic ready-object candidates become durable guards as well.
update public.file_cleanup_queue as cleanup
set retain_until = greatest(
  cleanup.remove_after,
  coalesce(attachment.quarantine_expires_at, clock_timestamp())
) + interval '24 hours'
from public.attachments as attachment
where cleanup.workspace_id = attachment.workspace_id
  and cleanup.attachment_id = attachment.id
  and cleanup.storage_path = attachment.id::text
  and attachment.state = 'quarantine'
  and cleanup.retain_until is null;

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

  -- Every lifecycle function locks an existing guard before its attachment.
  select * into guard
  from public.file_cleanup_queue
  where workspace_id = p_workspace_id and storage_path = p_ready_path
  for update;

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
    returning * into guard;
  else
    update public.file_cleanup_queue
    set
      attachment_id = p_attachment_id,
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
  end if;

  return guard.id;
end;
$$;

revoke all on function public.arm_attachment_ready_cleanup(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.arm_attachment_ready_cleanup(uuid, uuid, text)
  to service_role;

drop function if exists public.prepare_file_cleanup_object(uuid);
create function public.prepare_file_cleanup_object(p_queue_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.file_cleanup_queue%rowtype;
  attachment public.attachments%rowtype;
  observed_at timestamptz := clock_timestamp();
  cleanup_lease uuid;
begin
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id
    and remove_after <= observed_at
    and (lease_id is null or lease_expires_at <= observed_at)
  for update;
  if not found then return null; end if;

  if candidate.attachment_id is not null then
    select * into attachment
    from public.attachments
    where workspace_id = candidate.workspace_id and id = candidate.attachment_id
    for update;

    if found and attachment.state = 'ready' and attachment.storage_path = candidate.storage_path then
      delete from public.file_cleanup_queue where id = candidate.id;
      return null;
    end if;

    if found
      and attachment.state = 'quarantine'
      and candidate.storage_path = candidate.attachment_id::text
      and attachment.quarantine_expires_at > observed_at
    then
      update public.file_cleanup_queue
      set
        remove_after = attachment.quarantine_expires_at,
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
    select 1 from public.attachments
    where state = 'ready' and storage_path = candidate.storage_path
  ) then
    delete from public.file_cleanup_queue where id = candidate.id;
    return null;
  end if;

  cleanup_lease := extensions.gen_random_uuid();
  update public.file_cleanup_queue
  set
    lease_id = cleanup_lease,
    lease_expires_at = observed_at + interval '5 minutes',
    attempts = attempts + 1
  where id = candidate.id;
  return cleanup_lease;
end;
$$;

revoke all on function public.prepare_file_cleanup_object(uuid) from public, anon, authenticated;
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
  observed_at timestamptz := clock_timestamp();
begin
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id and lease_id = p_lease_id
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
  completed public.attachments%rowtype;
  guard public.file_cleanup_queue%rowtype;
begin
  if p_ready_path <> p_attachment_id::text then
    raise exception 'attachment_ready_path_invalid' using errcode = '22023';
  end if;

  select * into guard
  from public.file_cleanup_queue
  where workspace_id = p_workspace_id and storage_path = p_ready_path
  for update;

  if not found or guard.attachment_id is distinct from p_attachment_id then
    raise exception 'attachment_cleanup_guard_missing' using errcode = '40001';
  end if;
  if guard.lease_id is not null then
    raise exception 'attachment_cleanup_in_progress' using errcode = '40001';
  end if;

  update public.attachments as target
  set
    name = p_name,
    mime_type = p_mime_type,
    size_bytes = p_size_bytes,
    storage_path = p_ready_path,
    storage_layout = 'opaque',
    state = 'ready',
    sha256 = p_sha256,
    completed_at = clock_timestamp(),
    quarantine_expires_at = null
  where target.workspace_id = p_workspace_id
    and target.id = p_attachment_id
    and target.state = 'quarantine'
    and target.storage_path = p_expected_quarantine_path
    and target.quarantine_expires_at > clock_timestamp()
    and target.deleted_at is null
    and (
      (
        target.task_id is not null
        and exists (
          select 1 from public.tasks as parent
          where parent.workspace_id = p_workspace_id
            and parent.id = target.task_id
            and parent.deleted_at is null
        )
      )
      or (
        target.knowledge_item_id is not null
        and exists (
          select 1 from public.knowledge_items as parent
          where parent.workspace_id = p_workspace_id
            and parent.id = target.knowledge_item_id
            and parent.deleted_at is null
        )
      )
    )
  returning * into completed;

  if not found then
    raise exception 'attachment_completion_conflict' using errcode = '40001';
  end if;

  delete from public.file_cleanup_queue where id = guard.id;

  insert into public.file_cleanup_queue (
    workspace_id, attachment_id, storage_path, remove_after,
    retain_until, lease_id, lease_expires_at
  ) values (
    p_workspace_id, p_attachment_id, p_expected_quarantine_path, clock_timestamp(),
    null, null, null
  )
  on conflict (workspace_id, storage_path) do update
    set
      attachment_id = excluded.attachment_id,
      remove_after = excluded.remove_after,
      retain_until = null,
      lease_id = null,
      lease_expires_at = null;

  return next completed;
end;
$$;

revoke all on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  to service_role;

-- Safe convergence. URL components are decoded repeatedly just like the API
-- predicate, so separators and credentials cannot hide behind nested percent encoding.
alter table public.secure_items drop constraint if exists secure_items_fixed_fields_check;
alter table public.secure_items drop constraint if exists secure_items_external_url_safe_check;
alter table public.secure_items drop constraint if exists secure_items_last_four_check;

create or replace function private.secure_item_text_is_safe(value text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select value is null or not (
    value ~* '(^|[^[:alnum:]])(password|passphrase|secret|token|credential|pin|cvv|cvc|otp|confirmation([[:space:]_.:/-]+code)?|пароль|секрет|токен|пин|(код[[:space:]_.:/-]*)?подтвержден[[:alpha:]]*)([[:space:]]*[:=/_\.-]+[[:space:]]*[^[:space:]]+|[[:space:]]+[^[:space:]]*([0-9]|[._~+/=-])[^[:space:]]*)'
    or value ~ '[0-9]([[:space:]_.:/-]*[0-9]){12,18}'
  )
$$;

create or replace function private.percent_decode_url_component(value text)
returns text
language plpgsql
immutable
strict
security definer
set search_path = ''
as $$
declare
  current_value text := value;
  next_value text;
  next_bytes bytea;
  character text;
  byte_pair text;
  character_index integer;
  decode_pass integer;
begin
  for decode_pass in 1..8 loop
    next_bytes := ''::bytea;
    character_index := 1;
    while character_index <= char_length(current_value) loop
      character := substr(current_value, character_index, 1);
      if character = '%' then
        byte_pair := substr(current_value, character_index + 1, 2);
        if char_length(byte_pair) <> 2 or byte_pair !~ '^[0-9a-fA-F]{2}$' then
          return null;
        end if;
        next_bytes := next_bytes || decode(byte_pair, 'hex');
        character_index := character_index + 3;
      else
        next_bytes := next_bytes || convert_to(character, 'UTF8');
        character_index := character_index + 1;
      end if;
    end loop;

    begin
      next_value := convert_from(next_bytes, 'UTF8');
    exception when others then
      return null;
    end;

    if next_value = current_value then return current_value; end if;
    current_value := next_value;
  end loop;
  return null;
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

  scanned_remainder := regexp_replace(
    decoded_remainder,
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
    '',
    'gi'
  );
  if not private.secure_item_text_is_safe(scanned_remainder) then return false; end if;

  if position('?' in decoded_remainder) > 0 then
    query_part := split_part(split_part(decoded_remainder, '?', 2), '#', 1);
    if query_part ~* '(^|&)[^=&]*(token|signature|credential|secret|password|passphrase|pin|cvv|cvc|otp|confirmation|x-amz-)[^=&]*(=|&|$)' then
      return false;
    end if;
  end if;
  return true;
end;
$$;

revoke all on function private.secure_item_text_is_safe(text) from public, anon, authenticated;
revoke all on function private.percent_decode_url_component(text) from public, anon, authenticated;
revoke all on function private.secure_item_url_is_safe(text) from public, anon, authenticated;
grant execute on function private.secure_item_text_is_safe(text) to service_role;
grant execute on function private.percent_decode_url_component(text) to service_role;
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
  add constraint secure_items_last_four_check check (last_four is null or last_four ~ '^[0-9]{4}$');
alter table public.secure_items
  add constraint secure_items_external_url_safe_check check (
    char_length(external_url) between 9 and 2000
    and private.secure_item_url_is_safe(external_url)
  );
