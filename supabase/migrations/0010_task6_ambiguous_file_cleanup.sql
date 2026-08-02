-- Reconcile ambiguous provider commits without exposing semantic Storage object names.
-- Existing workspace/state paths remain readable as legacy rows; every new object is opaque.

alter table public.attachments add column if not exists storage_layout text not null default 'opaque';

update public.attachments
set storage_layout = 'legacy'
where storage_path like '%/%';

alter table public.attachments drop constraint if exists attachments_storage_layout_check;
alter table public.attachments drop constraint if exists attachments_workspace_path;
alter table public.attachments
  add constraint attachments_storage_layout_check check (storage_layout in ('legacy', 'opaque'));
alter table public.attachments
  add constraint attachments_workspace_path check (
    (
      storage_layout = 'legacy'
      and storage_path ~ (
        '^' || workspace_id::text || '/' || state
        || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    )
    or (
      storage_layout = 'opaque'
      and storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and (state = 'quarantine' or storage_path = id::text)
    )
  );

do $attachment_workspace_identity$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.attachments'::regclass
      and conname = 'attachments_workspace_id_id_unique'
  ) then
    alter table public.attachments
      add constraint attachments_workspace_id_id_unique unique (workspace_id, id);
  end if;
end;
$attachment_workspace_identity$;

create unique index if not exists attachments_opaque_storage_path_unique
  on public.attachments (storage_path)
  where storage_layout = 'opaque';

alter table public.file_cleanup_queue add column if not exists attachment_id uuid;
alter table public.file_cleanup_queue drop constraint if exists file_cleanup_queue_check;
alter table public.file_cleanup_queue drop constraint if exists file_cleanup_queue_storage_path_check;
alter table public.file_cleanup_queue
  add constraint file_cleanup_queue_storage_path_check check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or storage_path ~ (
      '^' || workspace_id::text || '/(quarantine|ready)'
      || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

do $cleanup_attachment_scope$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.file_cleanup_queue'::regclass
      and conname = 'file_cleanup_queue_attachment_scope_fkey'
  ) then
    alter table public.file_cleanup_queue
      add constraint file_cleanup_queue_attachment_scope_fkey
      foreign key (workspace_id, attachment_id)
      references public.attachments(workspace_id, id);
  end if;
end;
$cleanup_attachment_scope$;

create unique index if not exists file_cleanup_queue_storage_path_global_unique
  on public.file_cleanup_queue (storage_path);

create index if not exists file_cleanup_queue_attachment_idx
  on public.file_cleanup_queue (workspace_id, attachment_id)
  where attachment_id is not null;

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
  if p_ready_path <> p_attachment_id::text then
    raise exception 'attachment_ready_path_invalid' using errcode = '22023';
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

  -- A pre-established ready-object cleanup candidate must disappear in the same
  -- transaction that makes that object live.
  delete from public.file_cleanup_queue
  where workspace_id = p_workspace_id and storage_path = p_ready_path;

  insert into public.file_cleanup_queue (workspace_id, attachment_id, storage_path, remove_after)
  values (p_workspace_id, p_attachment_id, p_expected_quarantine_path, clock_timestamp())
  on conflict (workspace_id, storage_path) do update
    set attachment_id = excluded.attachment_id, remove_after = excluded.remove_after;

  return next completed;
end;
$$;

revoke all on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.complete_attachment_upload(uuid, uuid, text, text, text, text, bigint, text)
  to service_role;

create or replace function public.prepare_file_cleanup_object(p_queue_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.file_cleanup_queue%rowtype;
  attachment public.attachments%rowtype;
begin
  select * into candidate
  from public.file_cleanup_queue
  where id = p_queue_id and remove_after <= clock_timestamp()
  for update;
  if not found then return false; end if;

  -- Lock the source attachment when it is known. A still-live quarantine can
  -- later claim its deterministic ready object, so cleanup waits for expiry.
  if candidate.attachment_id is not null then
    select * into attachment
    from public.attachments
    where workspace_id = candidate.workspace_id and id = candidate.attachment_id
    for update;

    if found and attachment.state = 'ready' and attachment.storage_path = candidate.storage_path then
      delete from public.file_cleanup_queue where id = candidate.id;
      return false;
    end if;
    if found
      and attachment.state = 'quarantine'
      and candidate.storage_path = candidate.attachment_id::text
      and attachment.quarantine_expires_at > clock_timestamp()
    then
      update public.file_cleanup_queue
      set remove_after = attachment.quarantine_expires_at
      where id = candidate.id;
      return false;
    end if;
  end if;

  -- Legacy queue rows may not have attachment_id. A current ready reference is
  -- still authoritative and causes the stale cleanup request to be discarded.
  if exists (
    select 1 from public.attachments
    where state = 'ready'
      and storage_path = candidate.storage_path
  ) then
    delete from public.file_cleanup_queue where id = candidate.id;
    return false;
  end if;

  -- Lease the row so two cleanup workers cannot remove the same object at once.
  update public.file_cleanup_queue
  set remove_after = clock_timestamp() + interval '5 minutes', attempts = attempts + 1
  where id = candidate.id;
  return true;
end;
$$;

revoke all on function public.prepare_file_cleanup_object(uuid) from public, anon, authenticated;
grant execute on function public.prepare_file_cleanup_object(uuid) to service_role;
