# Security

How TinyTown keeps founders' accounts, money and data safe: how to report a problem, what we protect and from whom, the controls in place, how to rotate every secret, what to set in the Supabase and Vercel dashboards, what to do in an incident, and the checklist to run before launch.

The design is in `docs/INFRA.md`, provider setup in `docs/SETUP.md`, and incident playbooks in `docs/RUNBOOK.md`.

## Reporting a vulnerability

If you think you've found a security problem in TinyTown, please tell us privately first.

- **Preferred:** GitHub's private vulnerability reporting. On this repository, open **Security** → **Report a vulnerability**. Only the maintainers see the report.
- **Or email** [SECURITY EMAIL] (the same address as `/.well-known/security.txt`).

Please include what you found, the steps to reproduce it, and what an attacker could do with it. Don't include anyone else's data; your own test account is enough.

What you can expect from us:

- A reply within 3 working days, and a first assessment within 7.
- Updates as we fix it, and credit in the release notes if you'd like it.
- No legal action for research done in good faith: test only against your own account, don't read, change or delete other people's data, don't degrade the service for others (no load tests, no spam), and give us a reasonable time to fix the problem before you talk about it publicly.

In scope: the TinyTown site and its `/api`, the Stripe App's OAuth flow, and the GitHub App's install flow. Out of scope: reports from automated scanners with no demonstrated impact, missing best-practice headers with no exploit, rate limits on Supabase's own sign-in endpoints (those are Supabase's), and social engineering of the team.

> **Owner, before launch:** enable it under **Settings** → **Code security** → **Private vulnerability reporting**, replace `[SECURITY EMAIL]` here and in `public/.well-known/security.txt`, and make sure that inbox is read.

## Threat model

### What we protect

| Asset | Where it lives | Why it matters |
|---|---|---|
| Founders' Stripe App refresh and access tokens | `connections.secret` and `access_token`, AES-256-GCM under `TOKEN_ENCRYPTION_KEY` | Read access to a founder's whole Stripe revenue history |
| Founders' PostHog personal API keys | `connections.secret`, encrypted the same way | Query access to the founder's PostHog project |
| GitHub App private key | `GITHUB_APP_PRIVATE_KEY` (Vercel only) | Mints tokens for every installation: read access to founders' chosen repositories |
| Our Stripe secret key and webhook secret | Vercel only | Charging, refunding and reading every TinyTown customer; forging "paid" events |
| Supabase service-role key | Vercel only | Full read and write on every table, bypassing row-level security |
| Who has paid | `subscriptions` | The paywall: forging it means free access |
| Founders' cities | `worlds`, `profiles` | The game's state; the economy is checked on the server |
| Personal data | Supabase Auth (emails), `profiles`, logs | Emails, sign-in times, metrics. Privacy law applies |
| Admin console | `/api/admin/*`, `ADMIN_EMAILS` | Comps, waitlist invites, user lookups |

### Who we defend against

- **Anyone on the internet**: scanning, scraping, credential stuffing at sign-in, flooding endpoints, trying to reach internal addresses through us (SSRF), cross-site attacks on signed-in founders.
- **A signed-in founder, free or paid**: trying to read or change another founder's data, get the hosted game without paying, or mint in-game money (the one rule: only real metrics grow the city).
- **A founder's compromised browser or a malicious extension**: it can act as that founder, but it must not get server secrets or other founders' data.
- **A third party in the middle of a flow**: a forged OAuth callback, a replayed or forged Stripe webhook, a stolen `installation_id`.
- **Mistakes**: a half-configured deploy, a secret pasted into a log or a screenshot, a migration that forgets row-level security.

Out of scope: a compromised Vercel, Supabase, Stripe or GitHub account (we rely on their security and on 2FA for ours), and a founder's own Stripe or GitHub account being compromised.

### Trust boundaries

```
browser ──(HTTPS, Supabase access token as Bearer)──▶ /api on Vercel ──(service-role key)──▶ Supabase Postgres
   │                                                    │
   └──(supabase-js: sign-in only)──▶ Supabase Auth      ├──(our secret key)──▶ Stripe (billing)
                                                        ├──(founder's OAuth token)──▶ Stripe (their account)
Stripe ──(signed webhook)──▶ /api/billing/webhook       ├──(installation token)──▶ GitHub
Vercel Cron ──(CRON_SECRET)──▶ /api/cron/*              └──(founder's key, allowlisted hosts)──▶ PostHog
```

1. **Browser → API.** Nothing from the browser is trusted. Every route validates and size-caps its input; signed-in routes check the Supabase token with Supabase itself; data routes also need a paid plan; game actions are re-simulated on the server.
2. **API → Supabase.** Only the server holds the service-role key. Every table has row-level security on with no policies and no grants to `anon` or `authenticated`, so the public anon key in the browser can't read or write any table.
3. **Providers → API.** Stripe webhooks are verified against the raw bytes before parsing; OAuth callbacks need a signed, expiring state plus a cookie from the same browser; cron calls need `CRON_SECRET`.
4. **API → third parties.** Outbound hosts are fixed in code (Stripe, GitHub, Supabase), except PostHog, which is limited to an allowlist (`POSTHOG_HOSTS`, PostHog Cloud by default).

## Controls in place

**Authentication and authorisation**

- Every `/api` route except `/api/config`, the webhook, the OAuth callbacks, health, telemetry, email links and cron needs a valid Supabase access token (`requireUser`, `server/context.ts`). Tokens are checked with Supabase Auth and cached for a minute, keyed by a SHA-256 of the token, so a signed-out token keeps working for at most a minute.
- Data routes need a plan that gives access now (`requirePaid` → `hasAccess` in `server/billing.ts`): active, trialing or past due, and a plan cancelled at period end closes at that end even if its last webhook is lost.
- Waitlist mode gates every signed-in route (`checkAccess`, `server/access.ts`).
- The admin API answers 404 to anyone not in `ADMIN_EMAILS`, rate-limits each admin, and writes every change to `admin_audit` before it runs.
- Cron and deep health checks compare `CRON_SECRET` / `HEALTH_SECRET` in constant time.

**Payments**

- Stripe webhook: HMAC-SHA256 over the exact raw body with a five-minute tolerance, checked before parsing. The Vercel function gets the raw stream (`shouldAddHelpers: false`), and the Node adapter passes the bytes through untouched (tested).
- Subscription state is always re-read from Stripe on a webhook, so an out-of-order or replayed event can't set a stale status.
- Checkout is idempotent per user; a paying founder is sent to the portal instead of a second checkout.

**Connections**

- OAuth `state` is HMAC-signed under `STATE_SECRET`, names the user and provider, and expires in ten minutes; a nonce in an `HttpOnly; Secure; SameSite=Lax` cookie ties the callback to the browser that started it.
- Redirect URIs come from `APP_URL`, never from the request. Redirects after a callback may only go to a path on this site (`redirect()` refuses `//host` and `/\host`).
- Provider secrets at rest are AES-256-GCM with the user id and provider bound in as associated data, so a ciphertext copied onto another row won't open.
- GitHub installations are checked against the connecting user's own GitHub authorisation; an `installation_id` in a URL proves nothing alone.
- PostHog hosts must be HTTPS, on the allowlist, with no port or credentials (SSRF), and are re-checked on every use.

**Abuse and limits**

- Rate limits per user (and per IP or per link on unauthenticated routes) in two layers: an in-memory fixed window on each instance, then a shared counter in Postgres (`public.rate_hit()`, migration 0002), atomic under concurrency. If the database is slow (over 500 ms) or down, limits fail open with one log line a minute per instance and skip the database for 30 seconds; limits marked `failClosed` (for sign-in-like routes and webhooks) refuse with 503 instead. Keys are hashed before they're stored, so the table holds no user ids or IP addresses.
- Request bodies: 1 MB at the adapter, 16 KB for JSON routes (counted in bytes, announced lengths refused before reading), 512 KB for the webhook. JSON must be a UTF-8 object.
- Client IPs come from Vercel's `X-Real-IP`; anywhere else the adapter overwrites it with the socket address, so callers can't choose their own.
- Sign-in itself is Supabase's: its rate limits and Cloudflare Turnstile (see the dashboard settings below).

**Browser**

- A strict Content Security Policy on every page (`siteCsp()` in `server/http.ts`): scripts only from our origin and Turnstile, no inline scripts, no eval; connections only to our API and our Supabase project; no framing. Each source is justified in the code. Styles allow `'unsafe-inline'` because the boot screen is an inline `<style>` and the HUD uses `style` attributes; styles can't run code. Checked in Chromium against the production build (the demo, hosted sign-in with Turnstile, the legal pages, the 404 page and the admin console): no violations.
- API responses carry `default-src 'none'; frame-ancestors 'none'`, since they're data, never pages.
- On everything: HSTS (two years, subdomains, no preload), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on OAuth redirects), a `Permissions-Policy` that turns off camera, microphone, geolocation, payment, USB and the like, and `Cross-Origin-Opener-Policy: same-origin`.
- CORS: the API is same-origin only. Preflights get a 204 that grants nothing, and the adapter strips `Access-Control-Allow-Origin` from any response, so no route can opt in by accident. The API authenticates with a Bearer token, not cookies, so cross-site request forgery has nothing to ride on.
- Caching: hashed assets for a year, `immutable`; HTML pages `no-cache`; API responses `no-store`.

**Data**

- Every table: row-level security on, no policies, `revoke all … from anon, authenticated`. Security-definer functions pin `search_path = ''` and are executable by `service_role` only. A test (`tests/server-security.test.ts`) reads every migration and fails if any of this is missing.
- Errors to the browser are written for people; internals (stack traces, upstream bodies, SQL) only go to logs, and logs never carry tokens, keys or request bodies.

**Configuration**

- `checkEnv()` (`server/env.ts`) explains half-configured or malformed settings, naming variables and never their values: a billing key without its webhook secret, a public key in the service-role slot, a malformed encryption key, a non-HTTPS `APP_URL`, a private address in `POSTHOG_HOSTS` and so on. The Vercel build refuses to deploy with errors (`ENV_CHECK=warn` overrides), and the function logs every problem on its first request.
- Preview deployments return Stripe and OAuth flows to themselves (`VERCEL_BRANCH_URL` / `VERCEL_URL`), never to production.

**Supply chain**

- The server has no npm runtime dependencies (plain `fetch` and `node:crypto`). The browser adds `three` and `@supabase/supabase-js`. CodeQL and Dependabot run in CI.
- `npm audit --omit=dev`: **0 vulnerabilities** (2026-10-13). Also 0 with dev dependencies.

## Rotating secrets

Rotate a secret straight away if it may have leaked (a log, a screenshot, a departed collaborator, a lost laptop), and otherwise once a year. Every change in Vercel needs a redeploy to take effect (**Deployments** → the latest → **Redeploy**).

| Secret | How to rotate | Who notices |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | See the dual-key procedure below | Nobody, if done in order |
| `STATE_SECRET` | `openssl rand -base64 32`, replace in Vercel, redeploy | Anyone mid-way through connecting Stripe or GitHub (ten minutes' worth) starts again. **Unsubscribe links in emails already sent stop working** (they're signed with it), so rotate between digests and expect a few "this link doesn't work" pages |
| `SUPABASE_SERVICE_ROLE_KEY` | New-style keys: Supabase → **Project Settings** → **API Keys** → create a new secret key, put it in Vercel, redeploy, then delete the old one. Legacy JWT keys: rolling the JWT secret also rolls the anon key and signs everyone out, so move to the new key system instead | Nobody |
| `SUPABASE_ANON_KEY` | Same page, publishable keys. Public by design; rotate only if Supabase advises | Nobody |
| `STRIPE_BILLING_SECRET_KEY` | Stripe → **Developers** → **API keys** → **Roll key**, with an expiry on the old one (say 24 hours). Put the new one in Vercel, redeploy | Nobody |
| `STRIPE_WEBHOOK_SECRET` | Stripe → **Webhooks** → the endpoint → **Roll secret**, with an expiry on the old one. Stripe signs with both until it expires, and we accept either signature; update Vercel and redeploy before the old one expires | Nobody |
| `STRIPE_APP_SECRET_KEY` | As the billing key. Founders' refresh tokens are tied to the app, not to this key, so they keep working | Nobody |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App settings → **Generate a private key**, base64 it, update Vercel, redeploy, then delete the old key on GitHub | Nobody |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App settings → **Generate a new client secret**, update Vercel, redeploy, delete the old one | Anyone mid-way through connecting GitHub |
| `CRON_SECRET`, `HEALTH_SECRET` | `openssl rand -hex 32`, update Vercel, redeploy. Vercel Cron picks up the new value itself; update any uptime monitor that sends `HEALTH_SECRET` | A missed cron run at worst (jobs are idempotent) |
| `RESEND_API_KEY` | Resend → **API Keys** → create, update Vercel, redeploy, delete the old one | Nobody |
| `SENTRY_DSN` | Sentry → project → **Client Keys** → generate a new key, update Vercel, disable the old one | Nobody |
| Founders' own tokens | Not ours to rotate. If our database leaked, see "Incident response": they must be revoked | Founders reconnect |

### Rotating TOKEN_ENCRYPTION_KEY (dual-key)

Founders' Stripe and PostHog credentials are sealed with this key, so it can't simply be swapped: the old key must keep opening them until each is sealed again under the new one.

1. Make a new key: `openssl rand -base64 32`.
2. In Vercel, set `TOKEN_ENCRYPTION_KEY_OLD` to the **current** key and `TOKEN_ENCRYPTION_KEY` to the **new** one. Redeploy.
3. From now on everything is sealed with the new key, and anything that won't open with it is tried with the old one. Stripe tokens are sealed again whenever they're refreshed, which happens within the hour for every paying founder (the hourly cron refreshes their timelines). PostHog keys are sealed again the next time the founder's city is rebuilt from fresh metrics.
4. Wait for every connection to be re-sealed. A week is plenty for active founders; dormant ones may take longer. To check, compare `updated_at` on `connections` with the time of step 2 in the Supabase SQL editor: `select provider, count(*) from connections where updated_at < '…step 2 time…' and secret is not null group by provider;`
5. Remove `TOKEN_ENCRYPTION_KEY_OLD` and redeploy. Anything still sealed under the old key now fails to open, and that founder is asked to reconnect (the app handles this already).

If the old key itself leaked, skip the waiting: do steps 1 and 2, then remove the old key as soon as the active connections are re-sealed, and accept that dormant founders reconnect.

## Dashboard settings

These live in provider dashboards, not in code. Set them before launch.

### Supabase

- **Authentication → URL Configuration**: Site URL `https://YOUR-DOMAIN`. Redirect URLs: `https://YOUR-DOMAIN/**`, plus `http://localhost:5173/**` only on a development project. Remove any other wildcards. These are the only places a magic link or OAuth sign-in may land.
- **Authentication → Attack Protection → CAPTCHA**: enable Cloudflare Turnstile with the Turnstile **secret** key. Put the **site** key in Vercel as `TURNSTILE_SITE_KEY` (public). The app then shows the check on email sign-in. Create the Turnstile widget in Cloudflare with the production domain only.
- **Authentication → Rate Limits**: defaults are 30 sign-in/sign-up requests per 5 minutes per IP, one magic link per user per 60 seconds, and only 2 emails an hour on the built-in mailer. With custom SMTP set up (SETUP section 1), raise **emails sent** to fit the launch (say 100 an hour, then watch it) and leave the per-IP limits as they are.
- **Authentication → Attack Protection → leaked password protection**: not applicable; TinyTown has no passwords (magic links and Google/GitHub only). Keep **Email + Password** sign-in switched off under **Sign In / Providers** so nobody can create a password account.
- **Authentication → Sessions**: access tokens last 1 hour (keep it). Keep **detect and revoke compromised refresh tokens** on. On Pro, consider an **inactivity timeout** of 30 days so abandoned sessions end on their own.
- **Authentication → Emails**: custom SMTP (Resend) so sign-in mail always arrives, and the branded templates from `supabase/templates/`.
- **Authentication → Multi-factor**: enable TOTP and ask everyone in `ADMIN_EMAILS` to enrol. (The admin API doesn't yet require `aal2`; see "Known gaps".)
- **Project Settings → Data API**: keep it on (the server uses it). No table is granted to the browser roles; to check, run this in the SQL editor and expect no rows: `select table_name, privilege_type from information_schema.role_table_grants where grantee in ('anon', 'authenticated') and table_schema = 'public';`
- **Database → Network Restrictions**: these limit direct Postgres connections only (the HTTPS Data API, which our server uses, is not affected). Our migrations run from GitHub Actions (`.github/workflows/migrate.yml`), whose addresses change, so either leave restrictions off and keep the database password strong and in GitHub secrets only, or run migrations from a fixed address and restrict to it.
- **Database → SSL Configuration**: enforce SSL on direct connections.
- **Organization → Team**: everyone with access uses 2FA; remove people who no longer need it.
- **Database → Backups**: on Pro, daily backups are kept for 7 days; consider point-in-time recovery once there's revenue to protect. (`rate_limits` is unlogged and is not backed up; that's intended.)

### Vercel

- **Settings → Environment Variables**: mark every secret **Sensitive**. Give Preview test-mode Stripe keys, never live ones.
- **Settings → Deployment Protection**: Vercel Authentication on preview deployments, so previews (which may hold real data) aren't public.
- **Settings → Functions**: region next to Supabase (for `us-east-1`, Washington DC `iad1`, the default). Memory: the default 2 GB is plenty. Max duration comes from the build output (60 s).
- **Cron Jobs**: three crons are declared by the build (`/api/cron/hourly` at minute 7, `/api/cron/daily` at 03:17 UTC, `/api/cron/weekly` Mondays 15:23 UTC). Hobby allows only daily crons and fails the deploy on the hourly one; build with `CRON_HOURLY=off` until the project is on Pro. Set `CRON_SECRET`.
- **Firewall**: turn on the managed bot protection and consider an attack-mode switch for the launch day; add a rate-limit rule on `/api/*` (for example 300 requests a minute per IP) as a coarse first layer in front of ours.
- **Team**: 2FA for everyone; remove people who no longer need access.

### Stripe, GitHub, Cloudflare, Resend

- **Stripe**: 2FA on every team member; restricted keys for anything that isn't billing or the Stripe App; the webhook endpoint only subscribed to the four events in SETUP.
- **GitHub**: 2FA required in the organisation; branch protection on `main`; the GitHub App with Contents and Metadata read-only and nothing else; private vulnerability reporting on.
- **Cloudflare (Turnstile)**: the widget's hostnames limited to the production domain (and `localhost` on a separate test widget).
- **Resend**: the sending domain with SPF, DKIM and DMARC (`p=quarantine` once mail is flowing), so nobody can send convincing mail as TinyTown.

## Incident response

The detailed playbooks are in `docs/RUNBOOK.md`. The basics:

1. **Contain.** If a secret may have leaked, rotate it now (table above); don't wait to be sure. If someone is abusing the API, block them in the Vercel Firewall. If the site itself is the problem, roll back (**Deployments** → a good one → **Instant Rollback**).
2. **Preserve.** Export the Vercel logs for the window (they're kept for a limited time on each plan), note times in UTC, and screenshot what you saw. Don't delete data that shows what happened.
3. **Assess.** Which assets were reachable, for how long, and for which founders? `admin_audit` shows admin actions; Supabase's logs show database access by role.
4. **If founders' data or tokens were exposed:** rotate `TOKEN_ENCRYPTION_KEY` *and* revoke the founders' tokens. Stripe App: rolling our app's secret key doesn't revoke founders' refresh tokens, so delete the `connections` rows for Stripe (founders reconnect) and, if the app itself is compromised, contact Stripe. GitHub: delete the GitHub App's private keys and generate a new one; installation tokens die within the hour. PostHog: tell the affected founders to roll their personal API keys.
5. **Tell people.** Founders whose personal data was exposed must be told plainly and quickly: what happened, what it means for them, what we did, what they should do. Personal-data breaches may need reporting to a regulator within 72 hours (GDPR, UK GDPR); see the privacy policy and take advice.
6. **Learn.** A short write-up in `docs/` (no secrets): what happened, why, what changed so it can't again.

## Pre-launch checklist

- [ ] Private vulnerability reporting enabled on GitHub; `[SECURITY EMAIL]` replaced here and in `public/.well-known/security.txt`; that inbox is watched.
- [ ] All migrations applied to production in order (`0001` → latest), and `npx vitest run tests/server-security.test.ts` passes (the row-level-security lint).
- [ ] The grants query above returns no rows in the production database.
- [ ] Every variable in `docs/SETUP.md` set in Vercel Production, secrets marked Sensitive; the build log shows no `config error` lines and no unexpected `config warning` ones.
- [ ] Production uses live Stripe keys; `ALLOW_TEST_MODE` and `STRIPE_APP_INSTALL_URL` are unset.
- [ ] `TOKEN_ENCRYPTION_KEY` and `STATE_SECRET` are fresh `openssl rand` values that have never been in a chat, an issue or a screenshot, and are stored in the owner's password manager.
- [ ] `CRON_SECRET` set; the three crons show under **Settings** → **Cron Jobs**.
- [ ] Supabase: redirect URLs, Turnstile, rate limits, custom SMTP, password sign-in off, admin MFA enrolled.
- [ ] Vercel: Deployment Protection on previews, Firewall rule on `/api/*`, function region next to Supabase.
- [ ] `curl -sI https://YOUR-DOMAIN/` shows the CSP, HSTS and `X-Frame-Options` headers; `curl -s https://YOUR-DOMAIN/api/config` shows only public values.
- [ ] Open the live site with the browser console open: sign in (Turnstile appears), pay with a real card and refund it, connect Stripe and GitHub. No "Refused to …" CSP errors.
- [ ] `curl -s -X POST https://YOUR-DOMAIN/api/billing/webhook -d '{}'` answers 400 (no signature, refused), and Stripe → **Webhooks** → the endpoint shows recent deliveries answered 200.
- [ ] 2FA on Vercel, Supabase, Stripe, GitHub, Cloudflare, Resend and the domain registrar for everyone with access.
- [ ] HSTS preload: only once the domain and every subdomain are HTTPS-only for good. Add `; preload` to `Strict-Transport-Security` in `server/http.ts` and submit at hstspreload.org. It's hard to undo.

## Known gaps and accepted risks

- **Signed-out tokens work for up to a minute** (the auth cache). Supabase access tokens also live an hour on their own; signing out everywhere ends the refresh token, not the current access token. Accepted.
- **Admin access is by email only.** An admin whose email account is taken over can sign in as admin. Supabase MFA is available; the admin API should require `aal2` in the token for admins (a small change in `server/admin.ts`).
- **Rate limits fail open** when the database is unreachable, by design: refusing every founder to stop a hypothetical abuser is the worse outage. During that window each instance still applies its own in-memory limit, and the Vercel Firewall rule is the coarse backstop.
- **`style-src 'unsafe-inline'`.** Removing it means moving the boot screen's styles to a hashed `<style>` and the HUD's `style` attributes to CSSOM (`el.style.width = …`); worth doing if the CSP ever needs to be stricter.
- **The Supabase URL in the CSP** is narrowed to the project only when `SUPABASE_URL` is set at build time (it is on Vercel); otherwise any `*.supabase.co` project is allowed.
