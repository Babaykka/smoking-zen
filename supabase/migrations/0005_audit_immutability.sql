-- Audit rows are created only by SECURITY DEFINER entity triggers. The backend
-- may read the trail, but its service-role client cannot mutate it directly.

revoke all privileges on public.audit_events from service_role;
grant select on public.audit_events to service_role;

drop trigger if exists reject_audit_truncate on public.audit_events;
create trigger reject_audit_truncate
before truncate on public.audit_events
for each statement execute function private.reject_audit_mutation();
