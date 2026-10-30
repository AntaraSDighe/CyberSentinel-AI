begin;

select pg_catalog.pg_advisory_xact_lock(20261030, 2);

do $preflight$
declare
  expected_function oid :=
    pg_catalog.to_regprocedure(
      'public.consume_api_rate_limit(text,integer)'
    );
  actual_return_type text;
begin
  if current_user <> 'postgres' then
    raise exception 'Run this migration as postgres; no changes committed';
  end if;

  if pg_catalog.to_regrole('service_role') is null then
    raise exception 'Supabase service_role does not exist; no changes committed';
  end if;

  if expected_function is null and exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'consume_api_rate_limit'
  ) then
    raise exception
      'A conflicting public.consume_api_rate_limit overload exists; inspect it before migration';
  end if;

  if expected_function is not null then
    if exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'consume_api_rate_limit'
        and p.oid <> expected_function
    ) then
      raise exception
        'A conflicting public.consume_api_rate_limit overload exists; inspect it before migration';
    end if;

    select pg_catalog.regexp_replace(
      pg_catalog.pg_get_function_result(p.oid),
      '[[:space:]]',
      '',
      'g'
    )
    into actual_return_type
    from pg_catalog.pg_proc p
    where p.oid = expected_function;

    if coalesce(
         (select p.proargnames[1:3]::text[]
          from pg_catalog.pg_proc p
          where p.oid = expected_function),
         array[]::text[]
       ) <> array['p_bucket_hash', 'p_window_seconds', 'p_maximum']::text[]
       or actual_return_type <>
         'TABLE(allowedboolean,retry_after_secondsinteger,remaininginteger)' then
      raise exception
        'Existing public rate-limit function has incompatible argument names or return type';
    end if;
  end if;
end
$preflight$;

create table if not exists public.api_rate_limit_buckets (
  bucket_hash text not null,
  window_started_at timestamp with time zone not null,
  request_count integer not null,
  expires_at timestamp with time zone not null,
  constraint api_rate_limit_buckets_pkey primary key (bucket_hash),
  constraint api_rate_limit_buckets_bucket_hash_check
    check (bucket_hash ~ '^[a-f0-9]{64}$'),
  constraint api_rate_limit_buckets_request_count_check
    check (request_count > 0)
);

lock table public.api_rate_limit_buckets in access exclusive mode;

do $table_preflight$
declare
  actual_column_count integer;
  constraint_row record;
  normalized_expression text;
  has_hash_check boolean;
  has_count_check boolean;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'api_rate_limit_buckets'
      and c.relkind = 'r'
  ) then
    raise exception 'public.api_rate_limit_buckets is not an ordinary table';
  end if;

  select count(*)
  into actual_column_count
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.api_rate_limit_buckets'::regclass
    and a.attnum > 0
    and not a.attisdropped;

  if actual_column_count <> 4
     or exists (
       select 1
       from (values
         ('bucket_hash', 'text'),
         ('window_started_at', 'timestamp with time zone'),
         ('request_count', 'integer'),
         ('expires_at', 'timestamp with time zone')
       ) as expected(column_name, formatted_type)
       where not exists (
         select 1
         from pg_catalog.pg_attribute actual
         where actual.attrelid = 'public.api_rate_limit_buckets'::regclass
           and actual.attnum > 0
           and not actual.attisdropped
           and actual.attname = expected.column_name
           and pg_catalog.format_type(actual.atttypid, actual.atttypmod)
                 = expected.formatted_type
           and actual.attnotnull
       )
     ) then
    raise exception
      'public.api_rate_limit_buckets has incompatible columns, types, or nullability';
  end if;

  if exists (
    select 1
    from public.api_rate_limit_buckets b
    where b.bucket_hash is null
       or b.bucket_hash !~ '^[a-f0-9]{64}$'
       or b.window_started_at is null
       or b.request_count is null
       or b.request_count <= 0
       or b.expires_at is null
  ) then
    raise exception
      'Existing rate-limit rows violate the required data constraints';
  end if;

  if exists (
    select 1
    from public.api_rate_limit_buckets b
    group by b.bucket_hash
    having count(*) > 1
  ) then
    raise exception 'Duplicate bucket hashes exist; unique index not created';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.api_rate_limit_buckets'::regclass
      and c.contype not in ('c', 'p', 'u')
  ) then
    raise exception
      'Existing rate-limit table has an unsupported constraint; inspect before migration';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.api_rate_limit_buckets'::regclass
      and c.contype in ('p', 'u')
      and c.conkey <> array[
        (
          select a.attnum
          from pg_catalog.pg_attribute a
          where a.attrelid = 'public.api_rate_limit_buckets'::regclass
            and a.attname = 'bucket_hash'
        )
      ]::smallint[]
  ) then
    raise exception
      'Existing rate-limit table has an incompatible primary or unique constraint';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.api_rate_limit_buckets'::regclass
      and c.contype = 'c'
      and pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(c.conbin, c.conrelid),
        '[[:space:]()]',
        '',
        'g'
      ) not in (
        $expected$bucket_hash~'^[a-f0-9]{64}$'::text$expected$,
        'request_count>0'
      )
  ) then
    raise exception
      'Existing rate-limit table has an unsupported check constraint';
  end if;

  has_hash_check := false;
  has_count_check := false;
  for constraint_row in
    select c.conname,
           c.contype,
           pg_catalog.pg_get_expr(c.conbin, c.conrelid) as expression
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.api_rate_limit_buckets'::regclass
      and c.conname in (
        'api_rate_limit_buckets_bucket_hash_check',
        'api_rate_limit_buckets_request_count_check'
      )
  loop
    if constraint_row.contype <> 'c' then
      raise exception 'A rate-limit constraint name is already used incompatibly';
    end if;

    normalized_expression := pg_catalog.regexp_replace(
      constraint_row.expression,
      '[[:space:]()]',
      '',
      'g'
    );

    if constraint_row.conname = 'api_rate_limit_buckets_bucket_hash_check' then
      if normalized_expression <>
        $expected$bucket_hash~'^[a-f0-9]{64}$'::text$expected$ then
        raise exception 'Existing bucket-hash constraint is incompatible';
      end if;
    else
      if normalized_expression <> 'request_count>0' then
        raise exception 'Existing request-count constraint is incompatible';
      end if;
    end if;
  end loop;

  select exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.api_rate_limit_buckets'::regclass
      and c.contype = 'c'
      and pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(c.conbin, c.conrelid),
        '[[:space:]()]',
        '',
        'g'
      ) = $expected$bucket_hash~'^[a-f0-9]{64}$'::text$expected$
  ) into has_hash_check;

  select exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.api_rate_limit_buckets'::regclass
      and c.contype = 'c'
      and pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(c.conbin, c.conrelid),
        '[[:space:]()]',
        '',
        'g'
      ) = 'request_count>0'
  ) into has_count_check;

  if not has_hash_check then
    alter table public.api_rate_limit_buckets
      add constraint api_rate_limit_buckets_bucket_hash_check
      check (bucket_hash ~ '^[a-f0-9]{64}$');
  end if;

  if not has_count_check then
    alter table public.api_rate_limit_buckets
      add constraint api_rate_limit_buckets_request_count_check
      check (request_count > 0);
  end if;

  for constraint_row in
    select c.conname,
           pg_catalog.regexp_replace(
             pg_catalog.pg_get_expr(c.conbin, c.conrelid),
             '[[:space:]()]',
             '',
             'g'
           ) as expression
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.api_rate_limit_buckets'::regclass
      and c.contype = 'c'
      and not c.convalidated
  loop
    if constraint_row.expression =
         $expected$bucket_hash~'^[a-f0-9]{64}$'::text$expected$
       or constraint_row.expression = 'request_count>0' then
      execute pg_catalog.format(
        'alter table public.api_rate_limit_buckets validate constraint %I',
        constraint_row.conname
      );
    end if;
  end loop;
end
$table_preflight$;

do $index_preflight$
begin
  if pg_catalog.to_regclass(
       'public.api_rate_limit_buckets_bucket_hash_uidx'
     ) is not null
     and not exists (
       select 1
       from pg_catalog.pg_index i
       join pg_catalog.pg_class idx on idx.oid = i.indexrelid
       join pg_catalog.pg_am am on am.oid = idx.relam
       where idx.oid = pg_catalog.to_regclass(
           'public.api_rate_limit_buckets_bucket_hash_uidx'
         )
         and i.indrelid = 'public.api_rate_limit_buckets'::regclass
         and i.indisunique
         and i.indisvalid
         and i.indpred is null
         and i.indexprs is null
         and i.indnatts = 1
         and i.indnkeyatts = 1
         and i.indkey[0] = (
           select a.attnum
           from pg_catalog.pg_attribute a
           where a.attrelid = 'public.api_rate_limit_buckets'::regclass
             and a.attname = 'bucket_hash'
         )
         and am.amname = 'btree'
     ) then
    raise exception 'The expected bucket-hash index name is used incompatibly';
  end if;

  if pg_catalog.to_regclass('public.api_rate_limit_buckets_expiry_idx') is not null
     and not exists (
       select 1
       from pg_catalog.pg_index i
       join pg_catalog.pg_class idx on idx.oid = i.indexrelid
       join pg_catalog.pg_am am on am.oid = idx.relam
       where idx.oid = pg_catalog.to_regclass(
           'public.api_rate_limit_buckets_expiry_idx'
         )
         and i.indrelid = 'public.api_rate_limit_buckets'::regclass
         and not i.indisunique
         and i.indisvalid
         and i.indpred is null
         and i.indexprs is null
         and i.indnatts = 1
         and i.indnkeyatts = 1
         and i.indkey[0] = (
           select a.attnum
           from pg_catalog.pg_attribute a
           where a.attrelid = 'public.api_rate_limit_buckets'::regclass
             and a.attname = 'expires_at'
         )
         and am.amname = 'btree'
     ) then
    raise exception 'The expected expiry-index name is used incompatibly';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = idx.relam
    where i.indrelid = 'public.api_rate_limit_buckets'::regclass
      and i.indisunique
      and i.indisvalid
      and i.indpred is null
      and i.indexprs is null
      and i.indnatts = 1
      and i.indnkeyatts = 1
      and i.indkey[0] = (
        select a.attnum
        from pg_catalog.pg_attribute a
        where a.attrelid = 'public.api_rate_limit_buckets'::regclass
          and a.attname = 'bucket_hash'
      )
      and am.amname = 'btree'
  ) then
    create unique index api_rate_limit_buckets_bucket_hash_uidx
      on public.api_rate_limit_buckets (bucket_hash);
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class idx on idx.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = idx.relam
    where i.indrelid = 'public.api_rate_limit_buckets'::regclass
      and not i.indisunique
      and i.indisvalid
      and i.indpred is null
      and i.indexprs is null
      and i.indnatts = 1
      and i.indnkeyatts = 1
      and i.indkey[0] = (
        select a.attnum
        from pg_catalog.pg_attribute a
        where a.attrelid = 'public.api_rate_limit_buckets'::regclass
          and a.attname = 'expires_at'
      )
      and am.amname = 'btree'
  ) then
    create index api_rate_limit_buckets_expiry_idx
      on public.api_rate_limit_buckets (expires_at);
  end if;
end
$index_preflight$;

alter table public.api_rate_limit_buckets owner to postgres;
alter table public.api_rate_limit_buckets enable row level security;
revoke all on table public.api_rate_limit_buckets
  from public, anon, authenticated, service_role;
grant select on table public.api_rate_limit_buckets to service_role;
grant usage on schema public to service_role;

create or replace function public.consume_api_rate_limit(
  p_bucket_hash text,
  p_window_seconds integer,
  p_maximum integer
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_now timestamp with time zone := pg_catalog.clock_timestamp();
  v_request_count integer;
  v_expiry timestamp with time zone;
begin
  if p_bucket_hash is null
    or p_bucket_hash !~ '^[a-f0-9]{64}$'
    or p_window_seconds is null
    or p_window_seconds < 1
    or p_window_seconds > 86400
    or p_maximum is null
    or p_maximum < 1
    or p_maximum > 1000000
  then
    raise exception 'Invalid rate limit parameters';
  end if;

  insert into public.api_rate_limit_buckets as existing (
    bucket_hash, window_started_at, request_count, expires_at
  )
  values (
    p_bucket_hash,
    v_now,
    1,
    v_now + pg_catalog.make_interval(secs => p_window_seconds)
  )
  on conflict (bucket_hash) do update set
    window_started_at = case
      when existing.window_started_at <=
        v_now - pg_catalog.make_interval(secs => p_window_seconds)
      then v_now
      else existing.window_started_at
    end,
    request_count = case
      when existing.window_started_at <=
        v_now - pg_catalog.make_interval(secs => p_window_seconds)
      then 1
      when existing.request_count <= p_maximum
      then existing.request_count + 1
      else p_maximum + 1
    end,
    expires_at = case
      when existing.window_started_at <=
        v_now - pg_catalog.make_interval(secs => p_window_seconds)
      then v_now + pg_catalog.make_interval(secs => p_window_seconds)
      else existing.expires_at
    end
  returning existing.request_count, existing.expires_at
  into v_request_count, v_expiry;

  with expired_buckets as (
    select stale.bucket_hash
    from public.api_rate_limit_buckets as stale
    where stale.expires_at <= v_now
    order by stale.expires_at
    limit 100
    for update skip locked
  )
  delete from public.api_rate_limit_buckets as expired
  where expired.bucket_hash in (
    select expired_buckets.bucket_hash
    from expired_buckets
  );

  return query
  select
    v_request_count <= p_maximum,
    case
      when v_expiry <= v_now then 1
      else pg_catalog.ceil(
        extract(epoch from (v_expiry - v_now))
      )::integer
    end,
    case
      when v_request_count < p_maximum
        then p_maximum - v_request_count
      else 0
    end;
end;
$function$;

alter function public.consume_api_rate_limit(text, integer, integer)
  owner to postgres;

revoke all on function
  public.consume_api_rate_limit(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.consume_api_rate_limit(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
