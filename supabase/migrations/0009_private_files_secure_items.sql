-- Private-document quarantine lifecycle and fixed Bitwarden-backed safe metadata.
-- Browser roles remain locked out: every operation is mediated by a session-bound API.

create or replace function private.secure_item_text_is_safe(value text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select value is null or (
    value !~* '(password|passphrase|secret|token|cvv|cvc|otp|pin|пароль|секрет|токен|пин)[[:space:]]*[:=][[:space:]]*[^[:space:]]+'
    and value !~ '[0-9]([ -]*[0-9]){12,18}'
  )
$$;

revoke all on function private.secure_item_text_is_safe(text) from public, anon, authenticated;
grant execute on function private.secure_item_text_is_safe(text) to service_role;

alter table public.secure_items add column if not exists purpose text;
alter table public.secure_items add column if not exists owner text;
alter table public.secure_items add column if not exists review_date date;
alter table public.secure_items add column if not exists card_bank text;
alter table public.secure_items add column if not exists card_holder text;
alter table public.secure_items add column if not exists card_purpose text;
alter table public.secure_items add column if not exists last_four text;

do $migrate_legacy_secure_metadata$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'secure_items' and column_name = 'metadata'
  ) then
    execute $statement$
      update public.secure_items
      set
        purpose = coalesce(nullif(trim(metadata ->> 'purpose'), ''), 'Ссылка на запись в Bitwarden'),
        owner = coalesce(nullif(trim(metadata ->> 'owner'), ''), 'Команда')
      where purpose is null or owner is null
    $statement$;
  end if;
end;
$migrate_legacy_secure_metadata$;

update public.secure_items
set purpose = coalesce(nullif(trim(purpose), ''), 'Ссылка на запись в Bitwarden'),
    owner = coalesce(nullif(trim(owner), ''), 'Команда')
where purpose is null or owner is null or trim(purpose) = '' or trim(owner) = '';

alter table public.secure_items alter column purpose set not null;
alter table public.secure_items alter column owner set not null;
alter table public.secure_items drop column if exists metadata;

alter table public.secure_items drop constraint if exists secure_items_external_url_check;
alter table public.secure_items drop constraint if exists secure_items_fixed_fields_check;
alter table public.secure_items drop constraint if exists secure_items_external_url_safe_check;
alter table public.secure_items drop constraint if exists secure_items_last_four_check;

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
    and external_url ~ '^https://[^/@[:space:]]+([/?#][^[:space:]]*)?$'
    and external_url !~* '[?&](token|signature|credential|secret|password|passphrase|cvv|cvc|otp|pin|x-amz-[^=]*)='
  );

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
declare
  item public.secure_items%rowtype;
begin
  select * into item from public.secure_items
    where id = p_secure_item_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'secure_item_not_found' using errcode = 'P0002'; end if;
  if item.version <> p_expected_version then raise exception 'version_conflict' using errcode = '40001'; end if;
  if item.deleted_at is null then raise exception 'restore_not_deleted' using errcode = '55000'; end if;
  if item.deleted_at + interval '30 days' <= clock_timestamp() then
    raise exception 'restore_expired' using errcode = '22023';
  end if;

  update public.secure_items set deleted_at = null
    where id = p_secure_item_id and workspace_id = p_workspace_id;
  return query select * from public.secure_items
    where id = p_secure_item_id and workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.restore_secure_item_record(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.restore_secure_item_record(uuid, uuid, integer)
  to service_role;

alter table public.attachments add column if not exists state text not null default 'quarantine';
alter table public.attachments add column if not exists sha256 text;
alter table public.attachments add column if not exists created_by uuid;
alter table public.attachments add column if not exists quarantine_expires_at timestamptz
  default (clock_timestamp() + interval '125 minutes');
alter table public.attachments add column if not exists completed_at timestamptz;

update public.attachments
set quarantine_expires_at = clock_timestamp() + interval '125 minutes'
where state = 'quarantine' and quarantine_expires_at is null;

alter table public.attachments drop constraint if exists attachments_size_bytes_check;
alter table public.attachments drop constraint if exists attachments_workspace_path;
alter table public.attachments drop constraint if exists attachments_state_check;
alter table public.attachments drop constraint if exists attachments_mime_allowlist_check;
alter table public.attachments drop constraint if exists attachments_sha256_check;
alter table public.attachments drop constraint if exists attachments_state_consistency_check;
alter table public.attachments drop constraint if exists attachments_created_by_fkey;

alter table public.attachments
  add constraint attachments_size_bytes_check check (size_bytes between 1 and 26214400);
alter table public.attachments
  add constraint attachments_state_check check (state in ('quarantine', 'ready'));
alter table public.attachments
  add constraint attachments_mime_allowlist_check check (mime_type in (
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ));
alter table public.attachments
  add constraint attachments_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
alter table public.attachments
  add constraint attachments_state_consistency_check check (
    (
      state = 'quarantine'
      and sha256 is null
      and completed_at is null
      and quarantine_expires_at is not null
    )
    or (
      state = 'ready'
      and sha256 is not null
      and completed_at is not null
      and quarantine_expires_at is null
    )
  );
alter table public.attachments
  add constraint attachments_workspace_path check (
    storage_path ~ (
      '^' || workspace_id::text || '/' || state
      || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );
alter table public.attachments
  add constraint attachments_created_by_fkey foreign key (workspace_id, created_by)
    references public.workspace_members(workspace_id, user_id);

create index if not exists attachments_quarantine_cleanup_idx
  on public.attachments (quarantine_expires_at, workspace_id, id)
  where state = 'quarantine' and deleted_at is null;
create index if not exists attachments_ready_parent_idx
  on public.attachments (workspace_id, task_id, knowledge_item_id, created_at, id)
  where state = 'ready' and deleted_at is null;

create table if not exists public.file_cleanup_queue (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  storage_path text not null check (
    storage_path ~ (
      '^' || workspace_id::text || '/(quarantine|ready)'
      || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  ),
  remove_after timestamptz not null default clock_timestamp(),
  attempts integer not null default 0 check (attempts between 0 and 1000000),
  last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 120),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, storage_path)
);

create index if not exists file_cleanup_queue_due_idx
  on public.file_cleanup_queue (remove_after, created_at, id);

alter table public.file_cleanup_queue enable row level security;
revoke all privileges on public.file_cleanup_queue from public, anon, authenticated;
grant all privileges on public.file_cleanup_queue to service_role;

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
begin
  update public.attachments as target
  set
    name = p_name,
    mime_type = p_mime_type,
    size_bytes = p_size_bytes,
    storage_path = p_ready_path,
    state = 'ready',
    sha256 = p_sha256,
    completed_at = clock_timestamp(),
    quarantine_expires_at = null
  where target.workspace_id = p_workspace_id
    and target.id = p_attachment_id
    and target.state = 'quarantine'
    and target.storage_path = p_expected_quarantine_path
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

  insert into public.file_cleanup_queue (workspace_id, storage_path, remove_after)
  values (p_workspace_id, p_expected_quarantine_path, clock_timestamp())
  on conflict (workspace_id, storage_path) do update set remove_after = excluded.remove_after;

  return next completed;
end;
$$;

revoke all on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'workspace-files',
  'workspace-files',
  false,
  26214400,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists workspace_files_member_select on storage.objects;
drop policy if exists workspace_files_member_insert on storage.objects;
drop policy if exists workspace_files_member_update on storage.objects;
drop policy if exists workspace_files_member_delete on storage.objects;
revoke all privileges on storage.objects from public, anon, authenticated;
grant all privileges on storage.objects to service_role;

revoke all privileges on public.attachments from public, anon, authenticated;
revoke all privileges on public.secure_items from public, anon, authenticated;
grant all privileges on public.attachments to service_role;
grant all privileges on public.secure_items to service_role;
