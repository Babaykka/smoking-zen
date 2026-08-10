create or replace function public.replay_notification_outbox(
  p_outbox_id uuid,
  p_expected_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue public.notification_outbox%rowtype;
begin
  if p_expected_error_code is null or p_expected_error_code not in (
    'rate_limited', 'telegram_unavailable', 'network_error',
    'recipient_unavailable', 'configuration_error', 'invalid_response'
  ) then
    return false;
  end if;

  select * into queue
  from public.notification_outbox
  where id = p_outbox_id
  for update;

  if not found
    or queue.delivered_at is not null
    or queue.suppressed_at is not null
    or queue.dead_letter_at is null
    or queue.failed_at is null
    or queue.lease_id is not null
    or queue.lease_expires_at is not null
    or queue.last_error_code = 'delivery_indeterminate'
    or queue.last_error_code is distinct from p_expected_error_code then
    return false;
  end if;

  update public.notification_outbox
  set attempts = 0,
      available_at = clock_timestamp(),
      lease_id = null,
      lease_expires_at = null,
      last_error_code = null,
      failed_at = null,
      dead_letter_at = null
  where id = queue.id;

  return found;
end;
$$;

revoke all on function public.replay_notification_outbox(uuid, text)
  from public, anon, authenticated;
grant execute on function public.replay_notification_outbox(uuid, text)
  to service_role;

-- Converge private helper privileges to the exact schema-revision 0017
-- allowlist. New trigger helpers otherwise inherit PostgreSQL's PUBLIC
-- EXECUTE default even though they are never browser-callable.
revoke all privileges on schema private from public, anon, authenticated, service_role;
grant usage on schema private to authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;
grant execute on function private.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function private.is_workspace_owner(uuid) to authenticated, service_role;
grant execute on function private.storage_workspace_id(text) to authenticated, service_role;
grant execute on function private.broadcast_workspace_id(text) to authenticated, service_role;
grant execute on function private.secure_item_normalize(text) to service_role;
grant execute on function private.percent_decode_url_component(text) to service_role;
grant execute on function private.secure_item_scan_text(text) to service_role;
grant execute on function private.secure_item_text_is_safe(text) to service_role;
grant execute on function private.secure_item_url_is_safe(text) to service_role;
grant execute on function private.ensure_quarantine_cleanup_guard(uuid, uuid, text, timestamptz)
  to service_role;
