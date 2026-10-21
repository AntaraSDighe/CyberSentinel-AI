create extension if not exists pgcrypto;

create table if not exists public.audit_events (
  sequence bigint primary key,
  payload_text text not null,
  previous_hash text,
  event_hash text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_chain_heads (
  id integer primary key check (id = 1),
  sequence bigint not null,
  last_hash text not null,
  updated_at timestamptz not null default now()
);

create or replace function public.reject_audit_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.reject_audit_event_mutation();

revoke update, delete, truncate on public.audit_events from anon, authenticated;

create or replace function public.append_audit_event(p_payload_text text)
returns setof public.audit_events
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_sequence bigint := 0;
  current_hash text := null;
  next_sequence bigint;
  next_hash text;
  inserted public.audit_events;
begin
  perform pg_advisory_xact_lock(hashtext('cybersentinel-audit-chain'));

  select sequence, last_hash into current_sequence, current_hash
    from public.audit_chain_heads where id = 1 for update;
  current_sequence := coalesce(current_sequence, 0);
  next_sequence := current_sequence + 1;
  next_hash := encode(digest(coalesce(current_hash, '') || ':' || next_sequence::text || ':' || p_payload_text, 'sha256'), 'hex');

  insert into public.audit_events(sequence, payload_text, previous_hash, event_hash)
    values (next_sequence, p_payload_text, current_hash, next_hash)
    returning * into inserted;

  insert into public.audit_chain_heads(id, sequence, last_hash, updated_at)
    values (1, next_sequence, next_hash, now())
    on conflict (id) do update set sequence = excluded.sequence, last_hash = excluded.last_hash, updated_at = excluded.updated_at;

  return next inserted;
end;
$$;

revoke all on function public.append_audit_event(text) from public, anon, authenticated;
grant execute on function public.append_audit_event(text) to service_role;