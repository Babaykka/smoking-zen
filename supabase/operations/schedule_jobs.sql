begin;

-- Выполняется владельцем проекта после создания двух Vault secrets:
-- smoking_zen_app_origin и smoking_zen_internal_job_secret.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create schema if not exists smoking_zen_ops;
revoke all on schema smoking_zen_ops from public, anon, authenticated, service_role;
create table if not exists smoking_zen_ops.smoking_zen_job_requests (
  request_id bigint primary key,
  kind text not null check (kind in ('reminders', 'cleanup')),
  queued_at timestamptz not null default clock_timestamp()
);
revoke all on table smoking_zen_ops.smoking_zen_job_requests
  from public, anon, authenticated, service_role;

do $validation$
begin
  if (select count(*) from vault.decrypted_secrets
      where name in ('smoking_zen_app_origin', 'smoking_zen_internal_job_secret')) <> 2 then
    raise exception 'smoking_zen_operational_vault_secrets_missing';
  end if;
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'smoking_zen_app_origin'
      and decrypted_secret ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ) then
    raise exception 'smoking_zen_operational_origin_invalid';
  end if;
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'smoking_zen_internal_job_secret'
      and decrypted_secret ~ '^[A-Za-z0-9_-]{32,256}$'
  ) then
    raise exception 'smoking_zen_operational_secret_invalid';
  end if;
end;
$validation$;

select cron.schedule(
  'smoking-zen-reminders-v1',
  '*/5 * * * *',
  $job$
    with request as (
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets
                where name = 'smoking_zen_app_origin') || '/api/internal/reminders',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                        where name = 'smoking_zen_internal_job_secret'),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      ) as request_id
    )
    insert into smoking_zen_ops.smoking_zen_job_requests (request_id, kind)
    select request_id, 'reminders' from request;
  $job$
);

-- 00:30 UTC соответствует 03:30 Europe/Moscow.
select cron.schedule(
  'smoking-zen-cleanup-v1',
  '30 0 * * *',
  $job$
    with request as (
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets
                where name = 'smoking_zen_app_origin') || '/api/internal/cleanup',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                        where name = 'smoking_zen_internal_job_secret'),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      ) as request_id
    )
    insert into smoking_zen_ops.smoking_zen_job_requests (request_id, kind)
    select request_id, 'cleanup' from request;
  $job$
);

commit;
