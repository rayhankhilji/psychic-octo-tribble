-- TinyTown launch: the waitlist, comped plans, plan history and the admin audit log.
--
-- Same rules as 0001: row-level security ON, no policies, no grants to the
-- browser roles. Only the server (service role) reads or writes these.

-- ─── waitlist: everyone who asked to be let in ─────────────────────────────
create table public.waitlist (
  -- Always stored lowercased and trimmed, so one person is one row.
  email text primary key
    check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and position('@' in email) > 1),
  -- Where they came from: 'import' (the launch list), 'signin' (signed in before
  -- being invited), 'admin' (added by hand), or a campaign name.
  source text not null default 'import' check (char_length(source) between 1 and 40),
  -- When they joined the list. Imports keep the original date so "oldest first" is fair.
  created_at timestamptz not null default now(),
  -- Set once, when they're let in. Null means still waiting.
  invited_at timestamptz,
  -- Which batch let them in: 1, 2, 3… for waves; 0 for people invited by hand.
  wave integer check (wave >= 0),
  -- When the invite was handed to the email module (null after an interrupted
  -- batch, so the admin console can send the ones that were missed).
  notified_at timestamptz,
  -- First time they signed in with access, and who they are once they have.
  -- Deleting the account removes this row too (0006 clears every user_id table).
  signed_up_at timestamptz,
  user_id uuid references auth.users (id) on delete set null,
  check (wave is null or invited_at is not null)
);
-- "Invite the next N": the oldest people still waiting, optionally from one source.
create index waitlist_waiting on public.waitlist (created_at) where invited_at is null;
create index waitlist_source on public.waitlist (source, created_at);
create index waitlist_wave on public.waitlist (wave) where wave is not null;
create index waitlist_user on public.waitlist (user_id) where user_id is not null;

-- ─── subscriptions: comped plans ───────────────────────────────────────────
-- A comp is a subscriptions row with status 'active' and comp = true: no
-- Stripe customer or subscription, so the founder is never charged. The
-- reason is required, and who granted it is kept on the row as well as in
-- the audit log.
alter table public.subscriptions
  add column comp boolean not null default false,
  add column comp_reason text check (comp_reason is null or char_length(comp_reason) between 3 and 500),
  add column comp_by text,
  add column comp_at timestamptz,
  add constraint subscriptions_comp_has_reason check (not comp or comp_reason is not null);

-- ─── plan_changes: when plans started and ended ────────────────────────────
-- subscriptions holds only the current state, so "new paying founders this
-- week" and "churn this month" need a history. A trigger records every change
-- in whether a founder has paid access (and on what interval), whoever wrote
-- the row: the Stripe webhook, a comp, an account deletion.
-- The founder's id is deliberately not called `user_id` and has no foreign
-- key: deleting an account (0006's delete_user_data) removes everything named
-- user_id, but a bare id with a date is how churn stays countable afterwards.
create table public.plan_changes (
  id bigint generated always as identity primary key,
  founder_id uuid not null,
  at timestamptz not null default now(),
  -- started: gained paid access. ended: lost it. switched: changed interval or comp while paid.
  change text not null check (change in ('started', 'ended', 'switched')),
  from_status text,
  to_status text,
  plan_interval text,
  comp boolean not null default false
);
create index plan_changes_at on public.plan_changes (at desc);
create index plan_changes_founder on public.plan_changes (founder_id, at desc);

create or replace function public.record_plan_change() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  paid constant text[] := array['active', 'trialing', 'past_due'];
  was_paid boolean := false;
  is_paid boolean := false;
begin
  -- OLD and NEW are only touched on the operations that have them.
  if tg_op in ('UPDATE', 'DELETE') then
    was_paid := old.status = any (paid);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    is_paid := new.status = any (paid);
  end if;

  if is_paid and not was_paid then
    insert into public.plan_changes (founder_id, change, from_status, to_status, plan_interval, comp)
    values (new.user_id, 'started', case when tg_op = 'UPDATE' then old.status end, new.status, new.plan_interval, new.comp);
  elsif was_paid and not is_paid then
    insert into public.plan_changes (founder_id, change, from_status, to_status, plan_interval, comp)
    values (old.user_id, 'ended', old.status, case when tg_op = 'UPDATE' then new.status end, old.plan_interval, old.comp);
  elsif was_paid and is_paid and (old.plan_interval is distinct from new.plan_interval or old.comp is distinct from new.comp) then
    insert into public.plan_changes (founder_id, change, from_status, to_status, plan_interval, comp)
    values (new.user_id, 'switched', old.status, new.status, new.plan_interval, new.comp);
  end if;
  return null;
end;
$$;

create trigger subscriptions_plan_changes
  after insert or update or delete on public.subscriptions
  for each row execute function public.record_plan_change();

-- Founders who were already paying before this migration count as started now,
-- so the history isn't missing them (their real start is in Stripe).
insert into public.plan_changes (founder_id, change, to_status, plan_interval, comp)
select user_id, 'started', status, plan_interval, comp
from public.subscriptions
where status in ('active', 'trialing', 'past_due');

-- ─── admin_audit: every admin console call ─────────────────────────────────
create table public.admin_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  admin_id uuid not null,
  admin_email text not null,
  -- e.g. 'overview.read', 'user.read', 'comp.grant', 'waitlist.invite_next'.
  action text not null check (char_length(action) between 1 and 60),
  -- What it was done to: a user id, an email, or null for list views.
  target text,
  -- Changes carry a browser-made id so a double click or a retried request
  -- runs once; the second attempt finds this row and gets its result back.
  request_id text unique check (request_id is null or char_length(request_id) between 8 and 80),
  -- 'started' while a change runs, then 'ok' or 'error'. Reads are written as 'ok'.
  status text not null default 'ok' check (status in ('started', 'ok', 'error')),
  -- Inputs and a summary of the outcome. Never secrets.
  detail jsonb not null default '{}'::jsonb
);
create index admin_audit_at on public.admin_audit (at desc);
create index admin_audit_target on public.admin_audit (target, at desc) where target is not null;

-- ─── Lock it down ─────────────────────────────────────────────────────────
alter table public.waitlist enable row level security;
alter table public.plan_changes enable row level security;
alter table public.admin_audit enable row level security;

revoke all on table public.waitlist, public.plan_changes, public.admin_audit from anon, authenticated;
revoke all on function public.record_plan_change() from public, anon, authenticated;
