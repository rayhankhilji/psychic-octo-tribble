-- TinyTown email: who opted out of what, and a log so nothing is sent twice.
--
-- Same rules as 0001: row-level security ON, NO policies, no grants to the
-- browser roles. Only the server (service-role key) reads or writes these.
-- Neither table stores an email address: addresses are read from Auth when
-- a message is sent.

-- ─── email_prefs: non-essential mail, on by default ───────────────────────
-- No row means the defaults. Transactional mail (payments, plan changes,
-- broken connections, account changes) is always sent and has no switch.
create table public.email_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  product_updates boolean not null default true,
  weekly_digest boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ─── email_log: one row per email we mean to send once ─────────────────────
-- A sender claims `dedupe_key` (a sha256 of kind, recipient and the event's
-- own reference) by inserting the row before sending; a clash means someone
-- else already sent it or is sending it. Webhook retries and reruns of the
-- weekly digest are skipped this way.
create table public.email_log (
  dedupe_key text primary key check (dedupe_key ~ '^[0-9a-f]{64}$'),
  -- Null for mail to someone without an account (a waitlist invite).
  user_id uuid references auth.users (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 40),
  -- `sending` while claimed; `sent` once the provider accepted it.
  status text not null default 'sending' check (status in ('sending', 'sent')),
  provider text,
  -- The provider's message id, to find it in their logs.
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index email_log_user on public.email_log (user_id, kind, created_at desc);
-- The digest skips anyone with digests off; this keeps that lookup cheap.
create index email_prefs_digest_off on public.email_prefs (user_id) where weekly_digest = false;

alter table public.email_prefs enable row level security;
alter table public.email_log enable row level security;

revoke all on table public.email_prefs, public.email_log from anon, authenticated;
