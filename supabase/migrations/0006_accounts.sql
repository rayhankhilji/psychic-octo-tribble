-- TinyTown hosted: exporting and deleting an account (GET /api/account/export,
-- DELETE /api/account, server/account.ts).
--
-- Every table in 0001 already cascades from auth.users, so deleting the
-- Supabase user removes a founder's rows. This migration adds what that
-- doesn't cover:
--
-- 1. delete_user_data(uid): removes the user's rows from every public table
--    with a `user_id uuid` column, 0001's and any later module's, in one
--    transaction, before the auth user goes. A table whose rows must outlive
--    the account should not name its column `user_id`.
-- 2. export_user_data(uid): the same tables' rows for the export, except
--    0001's (the server exports those itself, field by field) and minus any
--    column whose name looks like a secret.
-- 3. A guard so a late write can't bring a deleted founder back. A Stripe
--    webhook retried after the account is gone, or a request riding a
--    sign-in cached for a minute, would otherwise hit the foreign key and
--    fail (and Stripe would keep retrying for three days). Inserts for a user
--    who no longer exists are dropped silently instead.
--
-- All three are server-only: the browser roles can't execute them.

-- ─── Which tables belong to a user ────────────────────────────────────────
-- Ordinary and partitioned tables in public with a uuid `user_id` column.
-- Partitions are reached through their parent.
create or replace function public.user_tables()
returns table (table_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.relname::text
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and not c.relispartition
    and a.attname = 'user_id'
    and a.atttypid = 'uuid'::regtype
    and not a.attisdropped
  order by c.relname
$$;

-- ─── delete_user_data(uid) ────────────────────────────────────────────────
-- Returns { table: rows deleted } for the tables that had any, for the log.
-- Safe to run twice: the second run finds nothing.
create or replace function public.delete_user_data(uid uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t text;
  n bigint;
  deleted jsonb := '{}'::jsonb;
begin
  if uid is null then
    raise exception 'delete_user_data: uid is required';
  end if;
  for t in select ut.table_name from public.user_tables() ut loop
    execute format('delete from public.%I where user_id = $1', t) using uid;
    get diagnostics n = row_count;
    if n > 0 then
      deleted := deleted || jsonb_build_object(t, n);
    end if;
  end loop;
  return deleted;
end;
$$;

-- ─── export_user_data(uid) ────────────────────────────────────────────────
-- { table: [rows] } for every user table outside 0001 that has rows for this
-- user. Columns that could hold a credential (tokens, keys, hashes, secrets,
-- ciphertext) are left out whatever the table: the export is a copy of the
-- founder's data, not of our means of acting for them.
create or replace function public.export_user_data(uid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t text;
  hidden text[];
  rows jsonb;
  exported jsonb := '{}'::jsonb;
begin
  if uid is null then
    raise exception 'export_user_data: uid is required';
  end if;
  for t in
    select ut.table_name from public.user_tables() ut
    where ut.table_name not in ('profiles', 'subscriptions', 'connections', 'worlds', 'timelines')
  loop
    select coalesce(array_agg(a.attname::text), '{}')
      into hidden
      from pg_catalog.pg_attribute a
      where a.attrelid = format('public.%I', t)::regclass
        and a.attnum > 0
        and not a.attisdropped
        and a.attname ~* '(secret|token|password|passwd|hash|cipher|key|nonce|salt|signature|otp)';
    execute format('select coalesce(jsonb_agg(to_jsonb(r) - $2), ''[]''::jsonb) from public.%I r where r.user_id = $1', t)
      into rows
      using uid, hidden;
    if jsonb_array_length(rows) > 0 then
      exported := exported || jsonb_build_object(t, rows);
    end if;
  end loop;
  return exported;
end;
$$;

-- ─── No rows for users who no longer exist ────────────────────────────────
create or replace function public.skip_rows_of_deleted_users()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from auth.users u where u.id = new.user_id) then
    -- Returning null drops this row (and an upsert's update) without an error.
    return null;
  end if;
  return new;
end;
$$;

create trigger profiles_skip_deleted_users before insert on public.profiles
  for each row execute function public.skip_rows_of_deleted_users();
create trigger subscriptions_skip_deleted_users before insert on public.subscriptions
  for each row execute function public.skip_rows_of_deleted_users();
create trigger connections_skip_deleted_users before insert on public.connections
  for each row execute function public.skip_rows_of_deleted_users();
create trigger worlds_skip_deleted_users before insert on public.worlds
  for each row execute function public.skip_rows_of_deleted_users();
create trigger timelines_skip_deleted_users before insert on public.timelines
  for each row execute function public.skip_rows_of_deleted_users();

-- ─── Lock it down ─────────────────────────────────────────────────────────
-- Supabase grants execute on new functions to anon and authenticated by
-- default; these must only ever run with the service-role key.
revoke all on function public.user_tables() from public, anon, authenticated;
revoke all on function public.delete_user_data(uuid) from public, anon, authenticated;
revoke all on function public.export_user_data(uuid) from public, anon, authenticated;
revoke all on function public.skip_rows_of_deleted_users() from public, anon, authenticated;
grant execute on function public.delete_user_data(uuid) to service_role;
grant execute on function public.export_user_data(uuid) to service_role;
