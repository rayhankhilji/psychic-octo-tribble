-- TinyTown hosted: accounts, billing, connections, saves and the timeline cache.
--
-- Every table has row-level security ON and NO policies, and the browser
-- roles have no grants: only the server, using the service-role key, can
-- read or write. The browser talks to /api/*, never to these tables.
-- Times the game uses (joined_at, last_seen, manual users) are snapshot days
-- in ms since epoch (bigint), matching src/data/types.ts.

-- ─── profiles: one per user ────────────────────────────────────────────────
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Seeds the founder's map layout (same plots and unlocks as everyone else).
  seed integer not null default (floor(random() * 2147483646) + 1)::integer
    check (seed between 1 and 2147483647),
  name text not null default 'Your Startup' check (char_length(name) between 1 and 40),
  -- Day the founder connected real data: the start of the back-pay window.
  joined_at bigint,
  -- Last day shown, for "while you were away".
  last_seen bigint,
  -- Where the population comes from: Stripe customers, a number the founder typed, or PostHog.
  users_source text not null default 'customers' check (users_source in ('customers', 'manual', 'posthog')),
  -- Manual user counts as [{ "t": day, "value": n }], oldest first, so history stays honest.
  users_manual jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── subscriptions: our Stripe customer and plan (written by the webhook) ─
create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  -- Stripe's own status string (active, trialing, past_due, canceled, unpaid, …).
  status text not null default 'none',
  price_id text,
  plan_interval text check (plan_interval in ('month', 'year')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  livemode boolean,
  updated_at timestamptz not null default now()
);

-- ─── connections: the founder's Stripe, GitHub and PostHog ─────────────────
create table public.connections (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('stripe', 'github', 'posthog')),
  -- Stripe account id (acct_…), GitHub installation id, or PostHog project id.
  account_id text not null,
  display_name text,
  livemode boolean,
  -- AES-256-GCM under TOKEN_ENCRYPTION_KEY: the Stripe refresh token or the PostHog key.
  secret text,
  -- Stripe only: the current access token (also encrypted) and when it expires.
  access_token text,
  access_expires_at timestamptz,
  -- Bumped on every token refresh, so two servers refreshing at once can't clobber each other.
  token_version integer not null default 0,
  -- Provider details: { repo } for GitHub, { host } for PostHog.
  metadata jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);
create index connections_account on public.connections (provider, account_id);

-- ─── worlds: the founder's choices ─────────────────────────────────────────
-- Treasury is never stored: it's always recomputed from metrics and actions.
create table public.worlds (
  user_id uuid primary key references auth.users (id) on delete cascade,
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  -- Optimistic concurrency: an action is saved only onto the version it was checked against.
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

-- ─── timelines: cached metrics, rebuilt after 15 minutes ──────────────────
create table public.timelines (
  user_id uuid primary key references auth.users (id) on delete cascade,
  timeline jsonb not null,
  fetched_at timestamptz not null default now()
);

-- ─── Lock it down ─────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.connections enable row level security;
alter table public.worlds enable row level security;
alter table public.timelines enable row level security;

revoke all on table public.profiles, public.subscriptions, public.connections, public.worlds, public.timelines from anon, authenticated;
