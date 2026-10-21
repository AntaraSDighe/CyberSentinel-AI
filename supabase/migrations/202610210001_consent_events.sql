create table if not exists public.actor_profiles (
  actor_id text primary key,
  display_name text,
  role text not null default 'user',
  created_at timestamptz not null default now()
);

create table if not exists public.consent_events (
  id uuid primary key,
  actor_id text not null references public.actor_profiles(actor_id),
  scope text not null,
  event_type text not null check (event_type in ('GRANTED', 'REVOKED', 'EXPIRED')),
  occurred_at timestamptz not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists consent_events_actor_scope_time_idx
  on public.consent_events (actor_id, scope, occurred_at, id);

create or replace function public.reject_consent_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'consent_events is append-only';
end;
$$;

drop trigger if exists consent_events_append_only on public.consent_events;
create trigger consent_events_append_only
  before update or delete on public.consent_events
  for each row execute function public.reject_consent_event_mutation();

revoke update, delete, truncate on public.consent_events from anon, authenticated;