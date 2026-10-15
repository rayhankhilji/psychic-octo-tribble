-- 0009: the introductory offer ("$9 for your first year, then $29 a year").
--
-- It's shown once, the first time a founder closes the paywall, and stays
-- open for 48 hours from that moment. Both moments live here, on the server,
-- so clearing a browser's storage never brings the offer back
-- (server/offer.ts):
--
-- - offer_shown_at: when it was first shown. Set once by
--   POST /api/billing/offer/seen and never changed after; the window is
--   offer_shown_at + 48 hours.
-- - offer_used_at: when a plan bought with it started (the billing webhook).
--   Final: a founder has the offer at most once.
--
-- Additive only: two nullable columns on profiles, which already has row-level
-- security on and no policies (0001), so only the service role reads or
-- writes them. user_state() (0007) returns the whole profile row with
-- to_jsonb, so the new columns reach the server without changing it. The
-- code before this migration ignores them; the code after it treats a
-- database without them as having no offer.
--
-- Undo: alter table public.profiles drop column offer_shown_at, drop column offer_used_at;

alter table public.profiles add column if not exists offer_shown_at timestamptz;
alter table public.profiles add column if not exists offer_used_at timestamptz;

comment on column public.profiles.offer_shown_at is 'When the introductory offer was first shown; it stays open 48 hours from here.';
comment on column public.profiles.offer_used_at is 'When a plan bought with the introductory offer started. A founder has the offer once.';

-- Row-level security stays on with no policies: the browser roles can't see these.
alter table public.profiles enable row level security;
