grant usage on schema public to service_role;

alter table public.actor_profiles enable row level security;
alter table public.consent_events enable row level security;
alter table public.audit_events enable row level security;
alter table public.audit_chain_heads enable row level security;
alter table public.protected_files enable row level security;
alter table public.approval_requests enable row level security;

revoke all on public.actor_profiles, public.consent_events, public.audit_events,
  public.audit_chain_heads, public.protected_files, public.approval_requests
  from anon, authenticated;

grant select, insert, update on public.actor_profiles to service_role;
grant select, insert on public.consent_events to service_role;
grant select on public.audit_events, public.audit_chain_heads to service_role;
grant select, insert on public.protected_files to service_role;
grant select, insert, update on public.approval_requests to service_role;

revoke all on function public.append_audit_event(text) from public, anon, authenticated;
grant execute on function public.append_audit_event(text) to service_role;
