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
), recorded as (
  insert into smoking_zen_ops.smoking_zen_job_requests (request_id, kind)
  select request_id, 'reminders' from request returning request_id
)
select request_id as reminders_request_id from recorded;

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
), recorded as (
  insert into smoking_zen_ops.smoking_zen_job_requests (request_id, kind)
  select request_id, 'cleanup' from request returning request_id
)
select request_id as cleanup_request_id from recorded;
