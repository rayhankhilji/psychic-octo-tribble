-- TinyTown launch: scheduled jobs and the data they keep.
--
-- `/api/cron/hourly` keeps paying founders' timelines fresh, `/api/cron/daily`
-- writes down each founder's numbers for the day and our own business
-- numbers, and tidies old rows; `/api/cron/weekly` sends the digest. See
-- server/cron.ts and server/pipelines/.
--
-- Same rules as 0001: row-level security ON, no policies, no grants to the
-- browser roles. Only the server (service role) reads or writes these.

-- ─── metric_snapshots: every founder's real numbers, one row per day ──────
-- The timeline is rebuilt from Stripe and GitHub, which only know the present:
-- a refunded subscription, a deleted repository or a revoked app would quietly
-- rewrite the past. This is the record of what each day actually looked like,
-- so the city never forgets a day. Days are UTC and complete (yesterday or
-- earlier); the last two are rewritten while late data settles, older ones
-- are never changed.
create table public.metric_snapshots (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  -- In major units of `currency` (dollars), as in the timeline.
  mrr numeric(16, 2) not null check (mrr >= 0),
  currency text not null check (char_length(currency) between 3 and 8),
  customers integer not null check (customers >= 0),
  -- Null when the founder's user source had no number for that day.
  users integer check (users >= 0),
  -- Cumulative, as in the timeline.
  releases integer not null check (releases >= 0),
  commits integer not null check (commits >= 0),
  -- A release published that day, if any.
  release text check (release is null or char_length(release) <= 200),
  -- Which sources stood behind the row. A settled day is never overwritten
  -- by a later build that knows less (say, after Stripe was disconnected).
  stripe boolean not null,
  github boolean not null,
  recorded_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ─── product_daily: TinyTown's own numbers, one row per UTC day ───────────
-- Counts of events on the day (signups, new paid, churned) are exact and can
-- be rebuilt for a missed day. Counts of state (paying, MRR, connected,
-- active) are measured when the daily job runs, a few hours after the day
-- ends, and are null on a day the job missed rather than guessed.
create table public.product_daily (
  day date primary key,
  -- Profiles created that day (a profile is made on first sign-in).
  signups integer not null check (signups >= 0),
  -- From plan_changes: gained or lost paid access that day.
  new_paid integer check (new_paid >= 0),
  churned integer check (churned >= 0),
  -- Founders with paid access, by plan, and comped plans (not paying).
  paying_monthly integer check (paying_monthly >= 0),
  paying_yearly integer check (paying_yearly >= 0),
  comped integer check (comped >= 0),
  -- List-price MRR of paying plans in the smallest unit of `currency` (cents).
  -- Coupons and taxes aren't taken off; Stripe's own MRR chart is the source
  -- of truth for money. Null when the prices couldn't be read.
  mrr_cents bigint check (mrr_cents >= 0),
  currency text,
  -- Founders with a Stripe account or a GitHub installation connected.
  stripe_connected integer check (stripe_connected >= 0),
  github_connected integer check (github_connected >= 0),
  -- Founders whose last visit was on or after the day / 7 days / 30 days before it.
  dau integer check (dau >= 0),
  wau integer check (wau >= 0),
  mau integer check (mau >= 0),
  measured_at timestamptz not null default now()
);

-- ─── cron_jobs: one row per scheduled job ──────────────────────────────────
-- A lease so a duplicate delivery can't run a job twice at once (Vercel may
-- deliver a scheduled run more than once), a cursor so a run that hits its
-- time limit carries on where it stopped, and the last result for the health
-- check and the admin console.
create table public.cron_jobs (
  job text primary key check (job in ('hourly', 'daily', 'weekly')),
  lease_until timestamptz not null default 'epoch',
  cursor jsonb,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_ok_at timestamptz,
  last_result jsonb not null default '{}'::jsonb
);
insert into public.cron_jobs (job) values ('hourly'), ('daily'), ('weekly');

-- ─── timeline_refresh: the hourly job's last try for each founder ──────────
-- Only failures matter: a success shows up as a fresh `timelines.fetched_at`.
-- A founder whose rebuild keeps failing waits longer each time (up to a day),
-- so one broken account can't hold up everyone behind it.
create table public.timeline_refresh (
  user_id uuid primary key references auth.users (id) on delete cascade,
  attempted_at timestamptz not null,
  -- Failures in a row, counting only since the last successful build.
  failures integer not null default 0 check (failures >= 0),
  retry_at timestamptz not null default 'epoch',
  -- A short code ('not_connected', 'upstream', 'timeout'), never a provider's message.
  error_code text check (error_code is null or char_length(error_code) <= 40)
);

-- ─── connection_breaks: connections that stopped working ──────────────────
-- One row per break, keyed by the connection's own connected_at: reconnecting
-- makes a new connection, so a later break is a new row. The insert is what
-- decides who sends the "your Stripe connection needs you" email, so it goes
-- out once however many runs notice.
create table public.connection_breaks (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('stripe', 'github', 'posthog')),
  connected_at timestamptz not null,
  detected_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (user_id, provider, connected_at)
);

-- ─── The hourly job's queue ────────────────────────────────────────────────
-- Paying founders with something to build from, with when they were last
-- refreshed or tried (`touched_at`, oldest first) and when a failing one may
-- be tried again. A fresh build after a failure clears the failure.
create view public.pipeline_refresh_queue with (security_invoker = true) as
select
  s.user_id,
  p.last_seen,
  greatest(coalesce(t.fetched_at, 'epoch'), coalesce(r.attempted_at, 'epoch')) as touched_at,
  case when r.attempted_at > coalesce(t.fetched_at, 'epoch') then r.retry_at else 'epoch'::timestamptz end as retry_at,
  case when r.attempted_at > coalesce(t.fetched_at, 'epoch') then r.failures else 0 end as failures
from public.subscriptions s
join public.profiles p on p.user_id = s.user_id
left join public.timelines t on t.user_id = s.user_id
left join public.timeline_refresh r on r.user_id = s.user_id
where s.status in ('active', 'trialing', 'past_due')
  and exists (
    select 1 from public.connections c
    where c.user_id = s.user_id
      and (c.provider = 'stripe' or (c.provider = 'github' and c.metadata ->> 'repo' is not null))
  );

-- ─── Indexes for the jobs' queries ─────────────────────────────────────────
-- Paying founders (the queue, the snapshot pass, the paying counts).
create index subscriptions_paid on public.subscriptions (user_id) where status in ('active', 'trialing', 'past_due');
-- Active in the last 14 days; DAU, WAU and MAU.
create index profiles_last_seen on public.profiles (last_seen) where last_seen is not null;
-- Signups per day.
create index profiles_created_at on public.profiles (created_at);
-- Old timeline caches to clean up.
create index timelines_fetched_at on public.timelines (fetched_at);
-- Connected counts (connections_account in 0001 leads with provider too, but
-- this one is smaller).
create index connections_provider on public.connections (provider);

-- ─── Lock it down ─────────────────────────────────────────────────────────
alter table public.metric_snapshots enable row level security;
alter table public.product_daily enable row level security;
alter table public.cron_jobs enable row level security;
alter table public.timeline_refresh enable row level security;
alter table public.connection_breaks enable row level security;

revoke all on table
  public.metric_snapshots, public.product_daily, public.cron_jobs, public.timeline_refresh,
  public.connection_breaks, public.pipeline_refresh_queue
from anon, authenticated;
