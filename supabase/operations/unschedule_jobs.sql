begin;

select cron.unschedule(jobid)
from cron.job
where jobname in ('smoking-zen-reminders-v1', 'smoking-zen-cleanup-v1');

commit;
