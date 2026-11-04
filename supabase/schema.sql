-- Store for channel-agent-gateway on Supabase (Postgres).
--
-- The gateway's store is a tiny Redis-like interface (src/store/index.ts):
-- string keys with TTLs, and lists. Here that is two tables in a private
-- schema, `gateway`, which the Data API doesn't expose, and a handful of
-- functions in `public` that the gateway calls over the Data API
-- (POST /rest/v1/rpc/<name>) with the service-role / secret key. Each store
-- operation is one function call, so one HTTP request.
--
-- Run this once in the SQL editor. It is safe to run again.

create schema if not exists gateway;

-- Strings: kv_get / kv_set / kv_incrby / store_del. A null expires_at never expires.
create table if not exists gateway.kv (
  key text primary key,
  value text not null,
  expires_at timestamptz
);

-- Lists: items numbered from `head` (inclusive) to `tail` (exclusive), so
-- appending and dropping from the front never renumber anything.
create table if not exists gateway.list_meta (
  key text primary key,
  head bigint not null default 0,
  tail bigint not null default 0,
  expires_at timestamptz
);
create table if not exists gateway.list_items (
  key text not null,
  idx bigint not null,
  value text not null,
  primary key (key, idx)
);

create index if not exists kv_expires_at on gateway.kv (expires_at);
create index if not exists list_meta_expires_at on gateway.list_meta (expires_at);

-- Nobody reads the tables directly; the security-definer functions below do.
alter table gateway.kv enable row level security;
alter table gateway.list_meta enable row level security;
alter table gateway.list_items enable row level security;

-- ── Strings ──

create or replace function public.kv_get(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select value from gateway.kv where key = p_key and (expires_at is null or expires_at > now());
$$;

-- Like SET key value PX ttl [NX]. Returns whether the value was written.
create or replace function public.kv_set(p_key text, p_value text, p_ttl_ms bigint, p_nx boolean default false)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  written int;
begin
  insert into gateway.kv as kv (key, value, expires_at)
  values (p_key, p_value, now() + p_ttl_ms * interval '1 millisecond')
  on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
    where not p_nx or kv.expires_at <= now();
  get diagnostics written = row_count;
  return written > 0;
end;
$$;

-- Like INCRBY followed by EXPIRE. An expired value counts as 0.
create or replace function public.kv_incrby(p_key text, p_by bigint, p_ttl_s bigint) returns bigint
language sql security definer set search_path = '' as $$
  insert into gateway.kv as kv (key, value, expires_at)
  values (p_key, p_by::text, now() + p_ttl_s * interval '1 second')
  on conflict (key) do update set
    value = ((case when kv.expires_at <= now() then 0 else kv.value::bigint end) + p_by)::text,
    expires_at = excluded.expires_at
  returning value::bigint;
$$;

-- Like DEL: strings and lists.
create or replace function public.store_del(p_keys text[]) returns void
language sql security definer set search_path = '' as $$
  delete from gateway.kv where key = any (p_keys);
  delete from gateway.list_items where key = any (p_keys);
  delete from gateway.list_meta where key = any (p_keys);
$$;

-- ── Lists ──

-- Like RPUSH followed by EXPIRE (no TTL change when p_ttl_s <= 0). Returns the new length.
create or replace function public.list_rpush(p_key text, p_values text[], p_ttl_s bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  m gateway.list_meta;
  n bigint := coalesce(array_length(p_values, 1), 0);
begin
  insert into gateway.list_meta (key) values (p_key) on conflict (key) do nothing;
  select * into m from gateway.list_meta where key = p_key for update;
  if m.expires_at is not null and m.expires_at <= now() then
    delete from gateway.list_items where key = p_key;
    m.head := 0;
    m.tail := 0;
    m.expires_at := null;
  end if;
  insert into gateway.list_items (key, idx, value)
  select p_key, m.tail + v.ord - 1, v.value from unnest(p_values) with ordinality as v(value, ord);
  update gateway.list_meta set
    head = m.head,
    tail = m.tail + n,
    expires_at = case when p_ttl_s > 0 then now() + p_ttl_s * interval '1 second' else m.expires_at end
  where key = p_key;
  return m.tail + n - m.head;
end;
$$;

-- Like LRANGE key start stop (inclusive; negative counts from the end).
create or replace function public.list_range(p_key text, p_start bigint, p_stop bigint) returns setof text
language plpgsql stable security definer set search_path = '' as $$
declare
  m gateway.list_meta;
  len bigint;
  s bigint;
  e bigint;
begin
  select * into m from gateway.list_meta where key = p_key and (expires_at is null or expires_at > now());
  if not found then return; end if;
  len := m.tail - m.head;
  s := case when p_start < 0 then greatest(len + p_start, 0) else p_start end;
  e := case when p_stop < 0 then len + p_stop else least(p_stop, len - 1) end;
  if s > e then return; end if;
  return query select i.value from gateway.list_items i
    where i.key = p_key and i.idx between m.head + s and m.head + e order by i.idx;
end;
$$;

-- Drop the first p_count items (like LTRIM key p_count -1).
create or replace function public.list_lpop(p_key text, p_count bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  m gateway.list_meta;
  new_head bigint;
begin
  select * into m from gateway.list_meta where key = p_key for update;
  if not found or p_count <= 0 then return; end if;
  new_head := least(m.head + p_count, m.tail);
  delete from gateway.list_items where key = p_key and idx < new_head;
  update gateway.list_meta set head = new_head where key = p_key;
end;
$$;

-- ── Housekeeping ──

-- Deletes everything past its TTL; scheduled daily below.
create or replace function public.store_expire() returns void
language sql security definer set search_path = '' as $$
  delete from gateway.kv where expires_at <= now();
  delete from gateway.list_items i using gateway.list_meta m
    where i.key = m.key and m.expires_at <= now();
  delete from gateway.list_meta where expires_at <= now();
$$;

-- Only the gateway's server key may call these (Supabase roles; skipped where they don't exist).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'kv_get(text)', 'kv_set(text,text,bigint,boolean)', 'kv_incrby(text,bigint,bigint)', 'store_del(text[])',
    'list_rpush(text,text[],bigint)', 'list_range(text,bigint,bigint)', 'list_lpop(text,bigint)', 'store_expire()'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    if exists (select from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', fn);
    end if;
    if exists (select from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function public.%s to service_role', fn);
    end if;
  end loop;
end;
$$;

-- Daily cleanup with pg_cron, where available (Supabase: Database → Extensions → pg_cron).
do $$
begin
  if exists (select from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('gateway-store-expire', '17 4 * * *', 'select public.store_expire()');
  end if;
exception when others then
  raise notice 'pg_cron not set up (%); run select public.store_expire() yourself now and then', sqlerrm;
end;
$$;
