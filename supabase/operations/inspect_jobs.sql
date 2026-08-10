select jobid, jobname, schedule, active
from cron.job
where jobname in ('smoking-zen-reminders-v1', 'smoking-zen-cleanup-v1')
order by jobname;

select jobid, runid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid in (
  select jobid from cron.job
  where jobname in ('smoking-zen-reminders-v1', 'smoking-zen-cleanup-v1')
)
order by start_time desc
limit 100;

select request.kind, request.request_id, request.queued_at,
  response.status_code, response.timed_out, response.created
from smoking_zen_ops.smoking_zen_job_requests request
left join net._http_response response on response.id = request.request_id
order by request.queued_at desc
limit 100;
