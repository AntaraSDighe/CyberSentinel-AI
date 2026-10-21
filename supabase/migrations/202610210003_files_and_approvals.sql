create table if not exists public.protected_files (
  id uuid primary key,
  actor_id text not null references public.actor_profiles(actor_id),
  name text not null,
  size bigint not null check (size >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  content_type text not null,
  permissions text[] not null default '{}',
  created_at timestamptz not null
);

create index if not exists protected_files_actor_created_idx
  on public.protected_files (actor_id, created_at desc);

create table if not exists public.approval_requests (
  id uuid primary key,
  actor_id text not null references public.actor_profiles(actor_id),
  file_id uuid not null references public.protected_files(id),
  status text not null check (status in ('pending', 'approved', 'expired', 'failed', 'released')),
  otp_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null,
  approved_at timestamptz
);

create index if not exists approval_requests_status_deadline_idx
  on public.approval_requests (status, expires_at);

revoke all on public.protected_files, public.approval_requests from anon, authenticated;