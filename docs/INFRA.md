# TinyTown hosted: the design

How the paid, hosted product works: accounts, billing, the paywall, connecting a founder's real data, saves, and the server-checked game. The API contract is `src/api/contract.ts`. Provider setup (what accounts to create, which keys go where) is `docs/SETUP.md`.

## Decisions (agreed with the owner)

- **Hosting:** Vercel (static front end + one serverless function for the API) and Supabase (auth + Postgres). No domain bought without asking.
- **Price:** $12 a month or $99 a year, through Stripe Checkout. **No free trial.** The demo stays free to look at.
- **The paywall comes before connecting real data.** Order: demo → sign in → pick a plan → Checkout → connect Stripe → connect GitHub (optional) → choose where active users come from → your city.
- **No pasted keys for Stripe.** Founders install the TinyTown Stripe App (OAuth 2.0, read-only permissions) and approve it on Stripe.
- **The one rule holds:** nothing earns or sells in-game money. Billing buys access to the hosted game, never money, land or speed.
- **Metrics are honest:** test-mode Stripe data never drives the economy (allowed only when `ALLOW_TEST_MODE=1`, for development).

## Shape

```
browser (Vite build, three.js)
  │  supabase-js, lazy-loaded: sign-in only (magic link, Google, GitHub)
  │  everything else: fetch /api/* with the Supabase access token
  ▼
/api/*  ── one handler, `server/app.ts` (web-standard Request → Response)
  │         served by `api/[...route].ts` on Vercel, and by `server/index.ts` locally
  ├─ Supabase Auth: who is this token? (GET /auth/v1/user)
  ├─ Supabase Postgres via PostgREST with the service-role key (server only)
  ├─ Stripe (our account): Checkout, customer portal, webhooks
  ├─ Stripe (the founder's account): Stripe App OAuth tokens → subscriptions → MRR history
  ├─ GitHub App: installation tokens → releases and commits
  └─ PostHog (optional): monthly active users
```

- The server has **no npm dependencies**: Stripe, Supabase and GitHub are plain `fetch` calls, as `server/sources.ts` already does. The browser adds one dependency, `@supabase/supabase-js`, loaded only when someone signs in.
- **Local development keeps working with no accounts.** Without `SUPABASE_URL`, `/api/config` says `hosted: false`, the app runs the demo or the `.env` integrations exactly as before, and no sign-in UI appears.

## Data (Supabase Postgres, `supabase/migrations/`)

All tables have row-level security on and **no policies**: the browser can't read or write them directly. Only the server, with the service-role key, touches them.

| Table | Holds |
|---|---|
| `profiles` | one per user: world seed, world name, joined/last-seen days |
| `subscriptions` | our Stripe customer and subscription, status, interval, period end (written by the webhook) |
| `connections` | per user and provider: account id, display name, livemode, **encrypted** refresh token or key, metadata |
| `worlds` | the founder's actions (builds, home picks) as JSON |
| `timelines` | cached metrics timeline per user, with when it was fetched |
| `oauth_states` | not needed: OAuth `state` is an HMAC-signed, expiring token naming the user |

Secrets at rest (Stripe refresh tokens, PostHog keys) are encrypted with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`, which lives only in the server environment.

## The game on the server

`POST /api/world/actions` re-runs `simulate()` from `src/game/economy.ts` on the server's own copy of the founder's timeline, with the saved actions plus the new one, and saves it only if the game accepts it (money, land and unlock rules all apply). The browser simulates too, for instant feedback, but the server's answer is the truth. Treasury is never stored; it's always recomputed from metrics and actions.

## Flows

- **Checkout:** `POST /api/billing/checkout` creates (or reuses) our Stripe customer for the user and a Checkout Session in subscription mode for the chosen price; the browser goes there; Stripe sends `checkout.session.completed` and `customer.subscription.*` to the webhook, which writes `subscriptions`. The return URL shows "You're in" and moves to connecting data.
- **Stripe App install:** `POST /api/connect/stripe` returns the marketplace install link with a signed `state`; Stripe redirects to `/api/connect/stripe/callback?code=…&state=…`; the server exchanges the code at `https://api.stripe.com/v1/oauth/token` with our app's secret key, stores the encrypted refresh token, and redirects to `/?connected=stripe`. Access tokens last an hour; the server refreshes as needed (refresh tokens roll on each use).
- **GitHub App install:** `POST /api/connect/github` returns `https://github.com/apps/<slug>/installations/new?state=…`; GitHub redirects to the callback with `installation_id`; the server checks the installation belongs to the user (via the user's GitHub OAuth code from the same flow), saves it, then the founder picks a repository.
- **Timeline:** `GET /api/timeline` returns the cached timeline if fresh (15 minutes), otherwise rebuilds it from the founder's connections with the same `revenueHistory`/`shippingActivity`/`mergeHistory` code the local server uses.

## Security checklist

- Every `/api` route except config, the webhook and the OAuth callbacks requires a valid Supabase token; data routes also require a paid plan (402).
- Webhook: Stripe signature (`Stripe-Signature`, HMAC-SHA256 over `t.payload`, 5-minute tolerance), checked before parsing.
- OAuth `state`: HMAC-SHA256 under `STATE_SECRET`, carries user id, provider and expiry (10 minutes); rejected if tampered or stale.
- No secret reaches the browser; `/api/config` exposes only the Supabase URL and anon key.
- Rate limits: cheap per-user throttles on actions and timeline rebuilds.
