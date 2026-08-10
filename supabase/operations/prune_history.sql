-- Ручная ограниченная очистка технической истории после экспорта нужной диагностики.
begin;

delete from cron.job_run_details
where end_time < clock_timestamp() - interval '30 days'
  and jobid in (
    select jobid from cron.job
    where jobname in ('smoking-zen-reminders-v1', 'smoking-zen-cleanup-v1')
  );

delete from net._http_response response
using smoking_zen_ops.smoking_zen_job_requests request
where response.id = request.request_id
  and request.queued_at < clock_timestamp() - interval '7 days';

delete from smoking_zen_ops.smoking_zen_job_requests request
where request.queued_at < clock_timestamp() - interval '7 days'
  and not exists (select 1 from net._http_response response where response.id = request.request_id);

commit;
