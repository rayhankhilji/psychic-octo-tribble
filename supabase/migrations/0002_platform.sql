-- TinyTown platform: a rate-limit counter shared by every server instance.
--
-- On Vercel each function instance has its own memory, so an in-memory limit
-- only slows down one instance. This table holds one fixed window per key,
-- and rate_hit() counts a hit atomically (one INSERT … ON CONFLICT, so two
-- instances hitting the same key at once can't both slip under the limit).
-- The server calls it through PostgREST: POST /rest/v1/rpc/rate_hit.
--
-- Keys arrive already hashed (server/ratelimit.ts): no user ids or IP
-- addresses are stored. Like every other table: RLS on, no policies, no
-- grants to the browser roles. Only the service role may call the function.

-- UNLOGGED: skips the write-ahead log, so hits are cheap. The price is that
-- a database crash empties the table, which for rate limits means everyone
-- starts a fresh window. It also isn't copied to read replicas or backups,
-- neither of which needs it.
create unlogged table public.rate_limits (
  key text primary key check (char_length(key) between 1 and 128),
  window_start timestamptz not null default now(),
  hits integer not null default 0 check (hits >= 0)
);
-- For pruning old windows.
create index rate_limits_window_start on public.rate_limits (window_start);

alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from anon, authenticated;

-- Counts one hit against p_key in a fixed window of p_window_s seconds and
-- says whether it is within p_max, and how long until the window resets.
create or replace function public.rate_hit(p_key text, p_window_s integer, p_max integer)
returns table (allowed boolean, retry_after_s integer)
language plpgsql
-- Runs as the table's owner with an empty search path (every name below is
-- schema-qualified), the pattern Supabase recommends for definer functions.
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval;
  v_start timestamptz;
  v_hits integer;
begin
  if p_key is null or char_length(p_key) not between 1 and 128
     or p_window_s is null or p_window_s not between 1 and 86400
     or p_max is null or p_max < 1 then
    raise exception 'rate_hit: bad arguments' using errcode = '22023';
  end if;
  v_window := make_interval(secs => p_window_s);

  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_start = case when r.window_start + v_window <= v_now then v_now else r.window_start end,
        hits = case when r.window_start + v_window <= v_now then 1 else least(r.hits, 2000000000) + 1 end
  returning r.window_start, r.hits into v_start, v_hits;

  -- Now and then, forget windows that ended long ago, so the table stays
  -- small without a scheduled job. No window is longer than a day.
  if random() < 0.002 then
    delete from public.rate_limits where window_start < v_now - interval '1 day';
  end if;

  allowed := v_hits <= p_max;
  retry_after_s := greatest(1, ceil(extract(epoch from (v_start + v_window - v_now)))::integer);
  return next;
end;
$$;

-- New functions in public are executable by everyone by default (and
-- Supabase's default privileges add anon and authenticated): take that back.
revoke all on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_hit(text, integer, integer) to service_role;
