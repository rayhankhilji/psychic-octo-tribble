-- TinyTown hosted: one round trip for what a signed-in request needs.
--
-- Opening a city used to cost about 34 database calls: every paid route read
-- `subscriptions` on its own, then the profile, then the world, then the
-- cached timeline, each one a separate PostgREST request. user_state()
-- returns all of that in one call, read fresh in one transaction, so the
-- server still checks "has paid" on every request (revocation stays
-- immediate) but pays for it once.
--
-- What it does, in order:
-- 1. The founder's profile, created on first sight (with the seed the server
--    picked). `created` says whether this call made it. The 0006 guard still
--    applies: no profile is made for a user who no longer exists, and the
--    result then has `profile: null`.
-- 2. Optionally counts one hit of a shared rate limit (public.rate_hit from
--    0002), so a write route doesn't need a second call for its limit.
-- 3. The plan row, and whichever of connections, world and cached timeline
--    the caller asked for (`p_parts`). Missing rows come back as null; the
--    world is never created here, so an unpaid caller writes nothing to it.
--
-- Additive only: it adds a function and changes no table, so the code before
-- it keeps working, and the code after it falls back to separate reads if it
-- isn't there yet (server/state.ts).
--
-- Undo: drop function public.user_state(uuid, integer, text[], text, integer, integer);

create or replace function public.user_state(
  p_user uuid,
  p_seed integer,
  p_parts text[],
  p_rate_key text,
  p_rate_window_s integer,
  p_rate_max integer
)
returns jsonb
language plpgsql
volatile
-- Runs as the tables' owner with an empty search path (every name below is
-- schema-qualified), like rate_hit() and the 0006 functions.
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_created boolean := false;
  v_parts text[] := coalesce(p_parts, '{}');
  v_allowed boolean;
  v_retry integer;
  v_out jsonb;
begin
  if p_user is null then
    raise exception 'user_state: p_user is required' using errcode = '22023';
  end if;

  select * into v_profile from public.profiles where user_id = p_user;
  if v_profile.user_id is null then
    -- `do nothing` keeps whichever row won if two first requests race; the
    -- loser waits for the winner to commit and then reads its row.
    insert into public.profiles (user_id, seed)
    values (p_user, coalesce(p_seed, (floor(random() * 2147483646) + 1)::integer))
    on conflict (user_id) do nothing
    returning * into v_profile;
    v_created := v_profile.user_id is not null;
    if not v_created then
      select * into v_profile from public.profiles where user_id = p_user;
    end if;
  end if;

  if p_rate_key is not null then
    select r.allowed, r.retry_after_s into v_allowed, v_retry
    from public.rate_hit(p_rate_key, p_rate_window_s, p_rate_max) r;
  end if;

  v_out := jsonb_build_object(
    'profile', case when v_profile.user_id is null then null else to_jsonb(v_profile) end,
    'created', v_created,
    'subscription', (select to_jsonb(s) from public.subscriptions s where s.user_id = p_user)
  );
  if 'connections' = any (v_parts) then
    v_out := v_out || jsonb_build_object('connections',
      coalesce((select jsonb_agg(to_jsonb(c)) from public.connections c where c.user_id = p_user), '[]'::jsonb));
  end if;
  if 'world' = any (v_parts) then
    v_out := v_out || jsonb_build_object('world', (select to_jsonb(w) from public.worlds w where w.user_id = p_user));
  end if;
  if 'timeline' = any (v_parts) then
    v_out := v_out || jsonb_build_object('timeline', (select to_jsonb(t) from public.timelines t where t.user_id = p_user));
  end if;
  if p_rate_key is not null then
    v_out := v_out || jsonb_build_object('rate', jsonb_build_object('allowed', v_allowed, 'retry_after_s', v_retry));
  end if;
  return v_out;
end;
$$;

-- Server only: Supabase grants execute on new functions to the browser roles by default.
revoke all on function public.user_state(uuid, integer, text[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.user_state(uuid, integer, text[], text, integer, integer) to service_role;
