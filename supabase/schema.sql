-- Store for serverless-agent-gateway on Supabase (Postgres).
--
-- After the session log of DeepSeek's dsh (deepseek-ai/deepseek-harness):
--   gateway.sessions  one row per chat: the log's header (who, where, format
--                     version) outside the log, plus the run state (cursor,
--                     turn counter, run lock, ambient sampling window).
--   gateway.events    the append-only log: (chat, seq) with seq contiguous per
--                     chat, the event type, time and its JSON data. The model's
--                     input is derived from it (src/conversation/derive.ts).
--   gateway.replies   per-message reply state (QQ msg_seq, reply count).
--   gateway.images    images referenced by events, as data URLs.
--   gateway.inbound   platform deliveries already seen (webhook retries).
--
-- For the admin console (/admin):
--   gateway.meta           schema version.
--   gateway.settings       configuration set in the console, by env var name;
--                          secrets are flagged so the console only shows them masked.
--   gateway.chat_profiles  per-chat settings: name, reply mode, quotas, tools.
--                          Not tied to sessions, so they outlive an expired chat.
--   gateway.usage_daily    per-chat counters per UTC day (turns, tokens, cost…).
--   gateway.admin_log      what admins changed or sent.
--
-- The tables live in a private schema the Data API doesn't expose, with RLS on.
-- The gateway calls the functions below over the Data API
-- (POST /rest/v1/rpc/<name>) with the server key; each returns jsonb. Only
-- service_role may execute them.
--
-- Run this once in the SQL editor, or from the admin console's setup page. It
-- is safe to run again, and running it again upgrades an older schema.

create schema if not exists gateway;

create table if not exists gateway.sessions (
  chat text primary key, -- "{channel}:{conversation}"
  channel text not null,
  conversation_id text not null,
  chat_type text not null default 'private' check (chat_type in ('private', 'group')),
  origin text, -- public origin of the deployment, for the worker hand-off
  format_version int not null default 1,
  next_seq bigint not null default 0,
  cursor bigint not null default -1, -- seq of the last user message a turn handled
  turn int not null default 0,
  lock_owner text,
  lock_expires_at timestamptz,
  ambient_until timestamptz, -- no ambient wake before this
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create table if not exists gateway.events (
  chat text not null references gateway.sessions (chat) on delete cascade,
  seq bigint not null,
  type text not null,
  time timestamptz not null default now(),
  data jsonb not null,
  -- Copied out of data for filtering in the table editor and in SQL.
  turn int generated always as ((data ->> 'turn')::int) stored,
  step int generated always as ((data ->> 'step')::int) stored,
  primary key (chat, seq)
);
create index if not exists events_chat_type on gateway.events (chat, type);

create table if not exists gateway.replies (
  chat text not null references gateway.sessions (chat) on delete cascade,
  event_id text not null,
  context jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (chat, event_id)
);

-- Written before the event that references them, so no foreign key; orphans are expired.
create table if not exists gateway.images (
  key text primary key,
  chat text not null,
  data_url text not null,
  created_at timestamptz not null default now()
);
create index if not exists images_chat on gateway.images (chat);

create table if not exists gateway.inbound (
  channel text not null,
  event_id text not null,
  direct boolean not null default false,
  seen_at timestamptz not null default now(),
  primary key (channel, event_id)
);

alter table gateway.sessions enable row level security;
alter table gateway.events enable row level security;
alter table gateway.replies enable row level security;
alter table gateway.images enable row level security;
alter table gateway.inbound enable row level security;

-- ── Helpers ──

create or replace function gateway.event_json(e gateway.events) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('seq', e.seq, 'type', e.type, 'time', (extract(epoch from e.time) * 1000)::bigint, 'data', e.data);
$$;

create or replace function gateway.session_json(s gateway.sessions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'chat', s.chat, 'channel', s.channel, 'conversationId', s.conversation_id, 'chatType', s.chat_type,
    'origin', s.origin, 'formatVersion', s.format_version,
    'createdAt', (extract(epoch from s.created_at) * 1000)::bigint, 'nextSeq', s.next_seq, 'cursor', s.cursor, 'turn', s.turn,
    'minSeq', coalesce((select min(e.seq) from gateway.events e where e.chat = s.chat), s.next_seq)
  );
$$;

-- Append events ({type, data} objects) to a locked session row; returns the first seq.
create or replace function gateway.append(p_chat text, p_events jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  first_seq bigint;
begin
  select next_seq into first_seq from gateway.sessions where chat = p_chat for update;
  if not found then raise exception 'no session %', p_chat; end if;
  insert into gateway.events (chat, seq, type, data)
  select p_chat, first_seq + e.ord - 1, e.value ->> 'type', coalesce(e.value -> 'data', '{}'::jsonb)
  from jsonb_array_elements(p_events) with ordinality as e(value, ord);
  update gateway.sessions
    set next_seq = first_seq + jsonb_array_length(p_events), last_active_at = now()
    where chat = p_chat;
  return first_seq;
end;
$$;

-- Lock the session row if p_owner holds the run lock; raise 'lock lost' otherwise.
create or replace function gateway.check_owner(p_chat text, p_owner text) returns void
language plpgsql set search_path = '' as $$
begin
  perform from gateway.sessions where chat = p_chat and lock_owner = p_owner for update;
  if not found then raise exception 'lock lost: %', p_chat; end if;
end;
$$;

-- ── Ingress ──

-- One webhook delivery in one transaction: de-duplicate, upsert the session,
-- with p_reset delete what it logged so far, append p_event, and decide whether
-- to wake the agent: p_direct always, others at most once per
-- p_ambient_interval_s. Waking tries the run lock for p_lock_owner.
-- A repeat delivery that is now direct appends p_upgrade instead (if given).
-- Event types are the caller's business; this only follows the flags.
-- Returns {status: duplicate | recorded | busy | acquired, seq}.
create or replace function public.chat_ingest(
  p_chat text, p_channel text, p_conversation_id text, p_chat_type text, p_origin text,
  p_event_id text, p_direct boolean, p_event jsonb, p_reset boolean, p_upgrade jsonb, p_wake boolean,
  p_ambient_interval_s int, p_lock_owner text, p_lock_ttl_ms bigint
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  first_seen boolean;
  n int;
  s gateway.sessions;
  ev jsonb := p_event;
  v_seq bigint;
  wake boolean;
  acquired boolean := false;
begin
  insert into gateway.inbound (channel, event_id, direct) values (p_channel, p_event_id, p_direct)
    on conflict do nothing;
  get diagnostics n = row_count;
  first_seen := n > 0;
  if not first_seen then
    if not p_direct or p_upgrade is null then return jsonb_build_object('status', 'duplicate'); end if;
    update gateway.inbound set direct = true where channel = p_channel and event_id = p_event_id and not direct;
    get diagnostics n = row_count;
    if n = 0 then return jsonb_build_object('status', 'duplicate'); end if;
    ev := p_upgrade;
  end if;

  insert into gateway.sessions as cur (chat, channel, conversation_id, chat_type, origin)
    values (p_chat, p_channel, p_conversation_id, p_chat_type, p_origin)
    on conflict (chat) do update set
      chat_type = excluded.chat_type,
      origin = coalesce(excluded.origin, cur.origin),
      last_active_at = now();

  if p_reset and first_seen then
    delete from gateway.images where key in (
      select jsonb_array_elements_text(e.data -> 'images') from gateway.events e
      where e.chat = p_chat and e.data ? 'images');
    delete from gateway.events where chat = p_chat;
    delete from gateway.replies where chat = p_chat;
  end if;
  v_seq := gateway.append(p_chat, jsonb_build_array(ev));

  select * into s from gateway.sessions where chat = p_chat;
  wake := p_wake and (p_direct or (p_ambient_interval_s > 0 and (s.ambient_until is null or s.ambient_until <= now())));
  if wake and not p_direct then
    update gateway.sessions set ambient_until = now() + p_ambient_interval_s * interval '1 second' where chat = p_chat;
  end if;
  if wake and p_lock_owner is not null then
    update gateway.sessions
      set lock_owner = p_lock_owner, lock_expires_at = now() + p_lock_ttl_ms * interval '1 millisecond'
      where chat = p_chat and (lock_expires_at is null or lock_expires_at <= now());
    acquired := found;
  end if;
  return jsonb_build_object(
    'status', case when not wake then 'recorded' when acquired then 'acquired' else 'busy' end,
    'seq', v_seq);
end;
$$;

-- ── Runs ──

-- The session row and its events after p_after_seq: {session, events}.
create or replace function public.chat_open(p_chat text, p_after_seq bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'session', (select gateway.session_json(s) from gateway.sessions s where s.chat = p_chat),
    'events', coalesce((
      select jsonb_agg(gateway.event_json(e) order by e.seq) from gateway.events e
      where e.chat = p_chat and e.seq > p_after_seq), '[]'::jsonb));
$$;

-- The lock holder's writes below all take p_owner and raise 'lock lost' if it no longer holds the lock.
create or replace function public.chat_append(p_chat text, p_owner text, p_events jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select gateway.check_owner(p_chat, p_owner);
  select to_jsonb(gateway.append(p_chat, p_events));
$$;

-- Delete events before p_seq (compaction) and the images they reference.
create or replace function public.chat_trim(p_chat text, p_owner text, p_seq bigint) returns jsonb
language sql security definer set search_path = '' as $$
  select gateway.check_owner(p_chat, p_owner);
  delete from gateway.images where key in (
    select jsonb_array_elements_text(e.data -> 'images') from gateway.events e
    where e.chat = p_chat and e.seq < p_seq and e.data ? 'images');
  with deleted as (delete from gateway.events where chat = p_chat and seq < p_seq returning 1)
  select to_jsonb(count(*)) from deleted;
$$;

-- The run lock: p_mode acquire (if free or expired) / renew (if ours) / release (if ours).
create or replace function public.chat_lock(p_chat text, p_owner text, p_ttl_ms bigint, p_mode text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_mode = 'acquire' then
    update gateway.sessions set lock_owner = p_owner, lock_expires_at = now() + p_ttl_ms * interval '1 millisecond'
      where chat = p_chat and (lock_expires_at is null or lock_expires_at <= now());
  elsif p_mode = 'renew' then
    update gateway.sessions set lock_expires_at = now() + p_ttl_ms * interval '1 millisecond'
      where chat = p_chat and lock_owner = p_owner;
  elsif p_mode = 'release' then
    update gateway.sessions set lock_owner = null, lock_expires_at = null
      where chat = p_chat and lock_owner = p_owner;
  else
    raise exception 'unknown lock mode %', p_mode;
  end if;
  return to_jsonb(found);
end;
$$;

-- Take the ambient sampling window if it has passed.
create or replace function public.chat_claim_ambient(p_chat text, p_interval_s int) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_interval_s <= 0 then return to_jsonb(false); end if;
  update gateway.sessions set ambient_until = now() + p_interval_s * interval '1 second'
    where chat = p_chat and (ambient_until is null or ambient_until <= now());
  return to_jsonb(found);
end;
$$;

create or replace function public.chat_begin_turn(p_chat text, p_owner text) returns jsonb
language sql security definer set search_path = '' as $$
  select gateway.check_owner(p_chat, p_owner);
  update gateway.sessions set turn = turn + 1, last_active_at = now() where chat = p_chat returning to_jsonb(turn);
$$;

create or replace function public.chat_set_cursor(p_chat text, p_owner text, p_cursor bigint) returns jsonb
language sql security definer set search_path = '' as $$
  select gateway.check_owner(p_chat, p_owner);
  update gateway.sessions set cursor = p_cursor where chat = p_chat returning to_jsonb(cursor);
$$;

-- ── Replies and images ──

create or replace function public.reply_get(p_chat text, p_event_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select context from gateway.replies where chat = p_chat and event_id = p_event_id;
$$;

create or replace function public.reply_put(p_chat text, p_event_id text, p_context jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  insert into gateway.replies (chat, event_id, context) values (p_chat, p_event_id, p_context)
    on conflict (chat, event_id) do update set context = excluded.context, updated_at = now()
    returning 'true'::jsonb;
$$;

create or replace function public.image_put(p_chat text, p_key text, p_data_url text) returns jsonb
language sql security definer set search_path = '' as $$
  insert into gateway.images (key, chat, data_url) values (p_key, p_chat, p_data_url)
    on conflict (key) do update set data_url = excluded.data_url
    returning 'true'::jsonb;
$$;

-- {key: data_url} for the keys that exist.
create or replace function public.image_get(p_keys text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, data_url), '{}'::jsonb) from gateway.images where key = any (p_keys);
$$;

-- ── Admin console ──

create table if not exists gateway.meta (
  key text primary key,
  value text not null
);

create table if not exists gateway.settings (
  key text primary key, -- the env var it stands in for, e.g. OPENAI_RESPONSES_MODEL
  value text not null,
  secret boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists gateway.chat_profiles (
  chat text primary key,
  profile jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists gateway.usage_daily (
  chat text not null,
  day date not null, -- UTC, so a day ends at 08:00 Beijing time, with the providers' daily limits
  counts jsonb not null, -- {"turns": 3, "cost_usd": 0.012, "images": 1, …}; numbers add up
  primary key (chat, day)
);
create index if not exists usage_daily_day on gateway.usage_daily (day);

-- An earlier version kept a separate chat history; the console now renders it from the events.
drop function if exists public.history_add(text, jsonb);
drop function if exists public.history_list(text, bigint, int);
drop table if exists gateway.history;

create table if not exists gateway.admin_log (
  id bigint generated always as identity primary key,
  time timestamptz not null default now(),
  action text not null,
  chat text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists admin_log_time on gateway.admin_log (time desc);

create table if not exists gateway.admin_login_failures (
  ip text not null,
  time timestamptz not null default now()
);
create index if not exists admin_login_failures_ip on gateway.admin_login_failures (ip, time);

alter table gateway.meta enable row level security;
alter table gateway.settings enable row level security;
alter table gateway.chat_profiles enable row level security;
alter table gateway.usage_daily enable row level security;
alter table gateway.admin_log enable row level security;
alter table gateway.admin_login_failures enable row level security;

create or replace function gateway.epoch_ms(t timestamptz) returns bigint
language sql immutable set search_path = '' as $$
  select (extract(epoch from t) * 1000)::bigint;
$$;

create or replace function public.gateway_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('schemaVersion', (select value::int from gateway.meta where key = 'schema_version'));
$$;

-- Gone since the one-time import from the environment was removed.
drop function if exists public.meta_get(text);
drop function if exists public.meta_put(text, text);

-- Settings: [{key, value, secret, updatedAt}].
create or replace function public.settings_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', key, 'value', value, 'secret', secret, 'updatedAt', gateway.epoch_ms(updated_at)) order by key), '[]'::jsonb)
  from gateway.settings;
$$;

-- [{key, value, secret}] in one transaction; a null value deletes the key.
create or replace function public.settings_put(p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
begin
  for e in select value from jsonb_array_elements(p_entries) loop
    if e ->> 'value' is null then
      delete from gateway.settings where key = e ->> 'key';
    else
      insert into gateway.settings (key, value, secret) values (e ->> 'key', e ->> 'value', coalesce((e ->> 'secret')::boolean, false))
        on conflict (key) do update set value = excluded.value, secret = excluded.secret, updated_at = now();
    end if;
  end loop;
  return to_jsonb(jsonb_array_length(p_entries));
end;
$$;

create or replace function public.profile_get(p_chat text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select profile from gateway.chat_profiles where chat = p_chat;
$$;

-- Replace a chat's profile; null deletes it.
create or replace function public.profile_put(p_chat text, p_profile jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_profile is null then
    delete from gateway.chat_profiles where chat = p_chat;
  else
    insert into gateway.chat_profiles (chat, profile) values (p_chat, p_profile)
      on conflict (chat) do update set profile = excluded.profile, updated_at = now();
  end if;
  return 'true'::jsonb;
end;
$$;

-- Add p_counts to the chat's counters for p_day, key by key.
create or replace function public.usage_add(p_chat text, p_day date, p_counts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into gateway.usage_daily as u (chat, day, counts) values (p_chat, p_day, p_counts)
    on conflict (chat, day) do update set counts = (
      select coalesce(jsonb_object_agg(k, coalesce((u.counts ->> k)::numeric, 0) + coalesce((p_counts ->> k)::numeric, 0)), '{}'::jsonb)
      from jsonb_object_keys(u.counts || p_counts) as k);
  return 'true'::jsonb;
end;
$$;

-- A chat's counters from p_from to p_to: [{day, counts}], oldest first.
create or replace function public.usage_list(p_chat text, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('day', day, 'counts', counts) order by day), '[]'::jsonb)
  from gateway.usage_daily where chat = p_chat and day between p_from and p_to;
$$;

-- Every chat's counters for one day: {chat: counts}.
create or replace function public.usage_day(p_day date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(chat, counts), '{}'::jsonb) from gateway.usage_daily where day = p_day;
$$;

-- Every chat that has a session or a profile, most recently active first.
create or replace function public.admin_chats(p_day date) returns jsonb
language sql stable security definer set search_path = '' as $$
  with keys as (
    select chat from gateway.sessions
    union select chat from gateway.chat_profiles
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'chat', k.chat, 'channel', s.channel, 'conversationId', s.conversation_id, 'chatType', s.chat_type,
    'turn', s.turn, 'locked', coalesce(s.lock_expires_at > now(), false),
    'lastActiveAt', gateway.epoch_ms(s.last_active_at),
    'profile', p.profile, 'usage', u.counts
  ) order by s.last_active_at desc nulls last), '[]'::jsonb)
  from keys k
  left join gateway.sessions s on s.chat = k.chat
  left join gateway.chat_profiles p on p.chat = k.chat
  left join gateway.usage_daily u on u.chat = k.chat and u.day = p_day;
$$;

-- The session and up to p_limit events before p_before, newest first.
create or replace function public.admin_events(p_chat text, p_before bigint, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'session', (select gateway.session_json(s) from gateway.sessions s where s.chat = p_chat),
    'events', coalesce((
      select jsonb_agg(gateway.event_json(e) order by e.seq desc) from (
        select * from gateway.events where chat = p_chat and seq < p_before order by seq desc limit p_limit
      ) e), '[]'::jsonb));
$$;

-- Append without holding the run lock (an admin's message); a running turn sees it at its next step.
create or replace function public.admin_append(p_chat text, p_events jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select to_jsonb(gateway.append(p_chat, p_events));
$$;

-- Take the run lock away from whoever holds it; that run stops at its next write.
create or replace function public.admin_unlock(p_chat text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update gateway.sessions set lock_owner = null, lock_expires_at = null where chat = p_chat and lock_owner is not null;
  return to_jsonb(found);
end;
$$;

-- Turns that ended badly since p_since (epoch ms), newest first.
create or replace function public.admin_problems(p_since bigint, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'chat', chat, 'seq', seq, 'turn', turn, 'time', gateway.epoch_ms(time),
    'reason', data ->> 'reason', 'error', data ->> 'error') order by time desc), '[]'::jsonb)
  from (
    select * from gateway.events
    where type = 'turn/end' and data ->> 'reason' in ('error', 'unreachable', 'max-steps')
      and time > to_timestamp(p_since / 1000.0)
    order by time desc limit p_limit
  ) e;
$$;

create or replace function public.admin_log_add(p_action text, p_chat text, p_detail jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  insert into gateway.admin_log (action, chat, detail) values (p_action, p_chat, coalesce(p_detail, '{}'::jsonb));
  select 'true'::jsonb;
$$;

create or replace function public.admin_log_list(p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'time', gateway.epoch_ms(time), 'action', action, 'chat', chat, 'detail', detail) order by id desc), '[]'::jsonb)
  from (select * from gateway.admin_log order by id desc limit p_limit) l;
$$;

-- Failed logins from p_ip in the last p_window_s seconds, after recording one more if p_record.
create or replace function public.admin_login_failures(p_ip text, p_record boolean, p_window_s int) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_record then
    insert into gateway.admin_login_failures (ip) values (p_ip);
  end if;
  return (select to_jsonb(count(*)) from gateway.admin_login_failures
    where ip = p_ip and time > now() - p_window_s * interval '1 second');
end;
$$;

-- ── Housekeeping ──

-- Chats quiet for p_days go away with everything they own; retries are only
-- tracked for an hour; images no event references are dropped after a day.
-- Usage and the admin log are kept 180 days. Chat profiles stay until an admin deletes them.
create or replace function public.gateway_expire(p_days int default 7) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  sessions_deleted int;
begin
  delete from gateway.sessions where last_active_at < now() - p_days * interval '1 day';
  get diagnostics sessions_deleted = row_count;
  delete from gateway.inbound where seen_at < now() - interval '1 hour';
  delete from gateway.images i where i.created_at < now() - interval '1 day' and not exists (
    select from gateway.events e where e.chat = i.chat and e.data -> 'images' ? i.key);
  delete from gateway.usage_daily where day < current_date - 180;
  delete from gateway.admin_log where time < now() - interval '180 days';
  delete from gateway.admin_login_failures where time < now() - interval '1 day';
  return jsonb_build_object('sessions', sessions_deleted);
end;
$$;

-- Only the gateway's server key may call these (Supabase roles; skipped where they don't exist).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'chat_ingest(text,text,text,text,text,text,boolean,jsonb,boolean,jsonb,boolean,int,text,bigint)',
    'chat_open(text,bigint)', 'chat_append(text,text,jsonb)', 'chat_trim(text,text,bigint)',
    'chat_lock(text,text,bigint,text)', 'chat_claim_ambient(text,int)', 'chat_begin_turn(text,text)',
    'chat_set_cursor(text,text,bigint)', 'reply_get(text,text)', 'reply_put(text,text,jsonb)',
    'image_put(text,text,text)', 'image_get(text[])', 'gateway_expire(int)',
    'gateway_info()', 'settings_list()', 'settings_put(jsonb)', 'profile_get(text)', 'profile_put(text,jsonb)',
    'usage_add(text,date,jsonb)', 'usage_list(text,date,date)', 'usage_day(date)',
    'admin_chats(date)', 'admin_events(text,bigint,int)', 'admin_append(text,jsonb)', 'admin_unlock(text)',
    'admin_problems(bigint,int)', 'admin_log_add(text,text,jsonb)', 'admin_log_list(int)',
    'admin_login_failures(text,boolean,int)'
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

-- Daily cleanup with pg_cron, where available.
do $$
begin
  if exists (select from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('gateway-expire', '17 4 * * *', 'select public.gateway_expire(7)');
  end if;
exception when others then
  raise notice 'pg_cron not set up (%); run select public.gateway_expire(7) now and then', sqlerrm;
end;
$$;

-- Keep in step with SCHEMA_VERSION in src/store/types.ts.
insert into gateway.meta (key, value) values ('schema_version', '2')
  on conflict (key) do update set value = excluded.value;

-- Let the Data API see new functions right away.
notify pgrst, 'reload schema';
