# TinyTown runbook

What to do when something breaks. Each playbook has the same four parts: **symptoms** (how you'll notice), **checks** (how to tell what's going on), **fix**, and a **message** you can send. Launch-week monitoring and the "stop the line" triggers are in `docs/LAUNCH.md`.

Ground rules for every incident:

- **Stop inviting first** (admin console: don't press "invite next"). It costs nothing and keeps the blast radius small.
- **Write down times** as you go (UTC). Vercel keeps runtime logs for only 1 day on Pro, so copy anything you'll need later.
- **Never paste a secret** into an email, a ticket, a chat or a screenshot while debugging.
- **Say what's true, not what's hoped.** "We're looking into it" is fine. "Fixed" means you've seen it working.

Places you'll look:

| What | Where |
|---|---|
| Our API health | `GET /api/health` (quick, public) and the deep check, which tests each provider and needs the health secret (`HEALTH_SECRET`, or `CRON_SECRET` if that's unset): `curl -H "Authorization: Bearer $HEALTH_SECRET" https://YOUR-DOMAIN/api/health?deep=1`. A failing critical check makes it answer 503. |
| Errors | Sentry → Issues |
| Requests | Vercel → project → Logs (filter by path, status) |
| Deploys | Vercel → project → Deployments |
| Payments | Stripe → Payments, Subscriptions, Disputes |
| Webhooks | Stripe → Workbench → Webhooks → your endpoint → Event deliveries |
| Database and auth | Supabase → Reports, Logs (API, Auth, Postgres), Authentication → Users |
| Email | Resend → Logs, Metrics |
| A founder's account | the admin console (plan, connections, waitlist status) |
| Status pages | [Vercel](https://www.vercel-status.com) · [Supabase](https://status.supabase.com) · [Stripe](https://status.stripe.com) · [GitHub](https://www.githubstatus.com) · [Resend](https://resend-status.com) · [Cloudflare](https://www.cloudflarestatus.com) |

Contents: [Stripe webhooks failing](#stripe-webhooks-failing) · [Stripe outage](#stripe-outage) · [Supabase down or slow](#supabase-down-or-slow) · [Magic links not arriving](#magic-link-emails-not-arriving) · [A spike of 429s](#a-spike-of-429s) · [A bad deploy](#a-bad-deploy) · [A leaked secret](#a-leaked-secret) · [A founder's Stripe connection is broken](#a-founders-stripe-connection-is-broken) · [Disputes and refund requests](#disputes-and-refund-requests) · [Account deletion by email](#account-deletion-requests-by-email) · [Data breach](#a-data-breach)

---

## Stripe webhooks failing

The webhook (`POST /api/billing/webhook`) is how TinyTown learns someone paid, renewed, switched plan or cancelled. If it fails, people pay and don't get in.

**Symptoms**
- "I paid but it still asks me to pick a plan."
- Stripe → Webhooks → your endpoint shows **Failed** or **Pending** deliveries; Stripe emails you about failures.
- Sentry or Vercel logs show 4xx/5xx on `/api/billing/webhook`.

**Checks**
1. Open a failed delivery in Stripe and read the response code:
   - **400 "Bad signature"**: `STRIPE_WEBHOOK_SECRET` doesn't match this endpoint (wrong mode, rolled secret, or a second endpoint). Each endpoint, and each mode, has its own `whsec_…`.
   - **503 "not configured"**: billing variables are missing on this deployment.
   - **5xx or timeout**: our code or Supabase failed. Look up the same time in Vercel logs and Sentry.
   - **3xx**: the endpoint URL redirects (e.g. `www.` vs bare domain). Stripe counts redirects as failures; use the final URL.
2. Is it every delivery or one event type? One type points at code; all of them points at config.

**Fix**
1. Fix the cause (correct the secret in Vercel and **redeploy**, fix the URL, or roll back a bad deploy).
2. **Replay what failed.** The webhook re-reads each subscription from Stripe before writing, so replaying in any order, or twice, is safe.
   - Live mode, Stripe retries failed deliveries automatically for **up to three days** with backoff, so after a fix most will heal on their own. Don't wait for that if people are locked out.
   - Dashboard: open the event → **Resend**. Works for events up to **15 days** old.
   - CLI, for events up to **30 days** old:
     ```bash
     stripe events resend evt_123 --webhook-endpoint=we_123 --live
     ```
     For many: list recent events of a type, then resend each failed one (the endpoint id `we_…` is on the endpoint's page; the Event deliveries tab lists which failed):
     ```bash
     stripe get /v1/events --live -d type=customer.subscription.updated -d limit=100
     ```
3. As a backstop, the daily cron reconciles plans that are past due, unfinished or ended, so nobody stays wrong for more than a day once the webhook works again.
4. Check one affected founder in the admin console: their plan should now say active.

**Message** (to someone who paid and is stuck)
> Thanks for letting me know, and sorry. Your payment went through, but our server didn't hear back from Stripe in time. I've fixed it and your plan is now active: reload TinyTown and you'll go straight to connecting your data. You haven't been charged twice.

---

## Stripe outage

**Symptoms**
- Checkout or "Manage billing" fails or hangs; `POST /api/billing/checkout` or `/api/billing/portal` returns 502.
- Timelines fail to refresh for founders (their own Stripe is read through the same API).
- [status.stripe.com](https://status.stripe.com) shows an incident.

**Checks**
- Is it all of Stripe or one product (API, Checkout, Dashboard, webhooks)?
- Does the deep health check show Stripe failing?

**Fix**
- **Nothing to fix on our side.** Stop inviting until it's resolved: new people can't pay.
- Existing cities keep working: timelines are cached and served from the last good copy when a rebuild fails.
- Webhooks Stripe couldn't send will arrive when it recovers. Afterwards, check Event deliveries for anything still pending and resend.
- Don't change keys or settings during someone else's outage.

**Message** (status post, or to anyone who writes)
> Stripe, who handle our payments, are having an outage right now, so new checkouts and plan changes can't go through. Your city is fine and nobody is being charged twice. We'll post when it's back.

---

## Supabase down or slow

Supabase holds sign-in and every save. Every signed-in API call checks the user's token with Supabase Auth, so if Auth is down, everything signed-in is down.

**Symptoms**
- Sign-in fails; the app shows errors after sign-in; `/api/me` returns 5xx or is slow.
- The deep health check shows Supabase failing or slow.
- Supabase → Reports: CPU pinned near 100%, memory full, or many slow queries.

**Checks**
1. [status.supabase.com](https://status.supabase.com): an incident in your region?
2. Supabase → Reports → Database: CPU, memory, disk IO. Logs → Postgres for errors, Logs → API for 5xx from PostgREST.
3. Did it start with a deploy (new queries) or a wave (more people)?

**Fix**
- **Provider outage:** stop inviting, post a status note, wait. Don't restore backups or restart things during their incident.
- **We're overloading it:**
  1. Stop inviting.
  2. Move compute up one size (Settings → Compute and Disk). **This restarts the database: a few minutes of downtime.** Worth it if CPU is pinned.
  3. If a deploy introduced a slow query, roll back (below).
- **Disk full:** Pro auto-grows disk, but check Settings → Compute and Disk if writes fail.
- **Data lost or corrupted:** Database → Backups → restore (Pro keeps 7 daily backups). **The project is unavailable during a restore**, and everything since that backup is lost. Last resort; decide calmly.

**Message**
> TinyTown is having trouble reaching its database right now, so signing in and saving aren't working. Nothing you've built is lost. We're on it and will update here when it's back.

---

## Magic-link emails not arriving

**Symptoms**
- "I never got the sign-in email." More than one or two of these in an hour means a real problem.
- Supabase → Logs → Auth: `429` / "email rate limit exceeded", or SMTP errors.
- Resend → Logs: bounces, or nothing sent at all.

**Checks**
1. **Send yourself one** from a seed inbox (Gmail, Outlook, iCloud). Arrived? Inbox or spam? How long?
2. Supabase → Logs → Auth around the time: rate limit errors mean the **auth email limit** (Authentication → Rate Limits) is too low for the wave. SMTP auth errors mean the Resend key in Supabase's SMTP settings is wrong or revoked.
3. Resend → Logs, filtered to `auth.YOUR-DOMAIN`: sent? delivered? bounced? Resend → Metrics: bounce rate (sending can be paused above **4%**), complaints.
4. One provider only (e.g. only Outlook addresses)? That's reputation or filtering at that provider.
5. The person: right address? Asked twice within 60 seconds (the per-user limit)? Corporate filter (Mimecast, Proofpoint) holding links?

**Fix**
- **Rate limit:** raise the auth email limit to cover the current wave, then send the next chunk smaller.
- **SMTP credentials:** paste a fresh Resend API key into Supabase → Authentication → Emails → SMTP.
- **Resend paused or bouncing:** stop inviting, read Resend's notice, fix the cause (bad addresses in the import; DNS), then resume slowly.
- **Spam folder:** check SPF, DKIM and DMARC pass (open the received mail → "show original"); keep the sign-in email short, plain and link-light.
- **For the person, right now:** suggest **Sign in with Google or GitHub**, which needs no email.

**Message** (macro: `docs/launch/support-macros.md`, "Sign-in email didn't arrive")
> Sorry about that. Sign-in emails come from auth@YOUR-DOMAIN and usually arrive within a minute. Could you check spam or "Promotions"? If it's not there, the quickest route is "Continue with Google" or "Continue with GitHub" on the sign-in screen, as long as it's the same email address you joined the waitlist with.

---

## A spike of 429s

A 429 means "too many requests". It can come from us (our rate limits), or from a provider we call.

**Symptoms**
- Vercel logs: many `429` responses on `/api/*`, or Sentry issues mentioning "rate limit".
- Founders see "Slow down" style errors, or timelines failing to load.

**Checks**
1. **Whose 429?**
   - Our own API (`code: "rate_limited"`): look at which route and which users or IPs. One user or IP = a script or a stuck browser tab. Many users = our limits are too tight for real traffic.
   - **Supabase Auth**: Logs → Auth. See the magic-link playbook.
   - **Stripe**: the response carries `Stripe-Rate-Limited-Reason` (`global-rate`, `endpoint-rate`, `global-concurrency`, …). Live limits are 100 requests/second globally and 25 per endpoint.
   - **GitHub**: `x-ratelimit-remaining: 0` per installation (5,000/hour), or a secondary limit (100 concurrent; 2,000 OAuth token requests an hour app-wide).
   - **Resend**: 10 requests/second per team.
2. Did it start with a wave chunk, a deploy, or a cron run?

**Fix**
- **Abuse from a few IPs:** Vercel → Firewall: block the IPs, or turn on Attack Challenge Mode while it lasts.
- **A stuck client** (one user hammering): ask them to reload; if a client bug, roll back.
- **Our limits too tight for real use:** raise them in the code (`server/ratelimit.ts`) and deploy; it's not a dashboard setting.
- **Provider limits:** slow down what we send (smaller invite chunks; let caches do their job). For Stripe or Resend sustained limits, ask their support for a raise. Stripe wants six weeks' notice for big increases.

**Message** (only if people noticed)
> Some of you hit "too many requests" errors this afternoon. We were letting people in faster than one of our providers liked. We've slowed the invites down and it's working again; if you saw an error, a reload will fix it.

---

## A bad deploy

**Symptoms**
- Errors or broken screens start right after a deploy; Sentry issues "first seen" at deploy time.

**Fix**
1. **Roll back first, debug second.** Vercel → project → Production deployment tile → **Instant Rollback** → pick the last good deployment → Confirm. It's instant. (CLI: `vercel rollback`.)
   - Pro can roll back to any deployment that was previously in production.
   - After a rollback, Vercel **stops promoting new pushes to production** until you undo it (the **Undo Rollback** button, or `vercel promote <deployment>`). Expect that; it's protecting you.
   - A rollback restores the old build **and its old environment variables**. If you changed a variable since, it won't come back with the rollback.
   - Cron jobs revert to the rolled-back deployment's schedule.
2. **Migrations don't roll back.** A rollback changes code, not the database. Our migrations only add tables and columns, so old code keeps working against the newer schema. If a migration *changed or removed* something old code needs:
   - Write a forward fix (a new migration that restores what's needed), test it on a branch database or locally, then run it. Don't hand-edit production tables.
   - If data was damaged, see "Supabase down or slow" → restore, as a last resort.
3. Reproduce the bug on a preview deployment, fix it, merge, then **Undo Rollback** by promoting the fixed deployment.
4. Check webhooks: anything that failed during the bad deploy needs resending (first playbook).

**Message**
> An update we shipped at [time] broke [what]. We rolled it back at [time] and everything's working again. If you saw an error between those times, a reload fixes it. Nothing was lost.

---

## A leaked secret

**Symptoms**
- A secret was committed, pasted, logged, screenshotted, or GitHub/Stripe secret scanning emailed you. Or you see activity you didn't cause.

**General steps**
1. **Rotate first, investigate after.** A leaked key is compromised the moment it's public, even if you delete the post.
2. Update the value in Vercel (Settings → Environment Variables, Production and Preview) and **redeploy**; run the deep health check.
3. Delete the old value at the provider once the new one works.
4. Remove it from wherever it leaked (and from git history if committed; rotation matters more than history).
5. Check the provider's logs for use you didn't make (Stripe → Developers → Logs; GitHub App → Advanced; Supabase → Logs).
6. If customer data could have been read, follow "A data breach".

**Per secret**

| Secret | How bad | How to rotate | What breaks while you do |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | **Critical.** Full read/write to every table, bypassing RLS. | With the new API keys: Project Settings → API Keys → create a new **secret** key, put it in Vercel, redeploy, then **delete** the old one. With the legacy `service_role` JWT, rotating means a new JWT secret, which also changes the anon key and signs everyone out; move to the new keys instead. | Nothing if you swap before deleting. |
| `TOKEN_ENCRYPTION_KEY` | High, **only together with a database leak**: it decrypts founders' Stripe and PostHog credentials. | There's no key versioning yet: a new key means every founder has to **reconnect** Stripe and PostHog. If only the key leaked (not the database), rotating isn't urgent. Plan it rather than doing it in a panic. | All Stripe and PostHog connections until founders reconnect. |
| `STRIPE_BILLING_SECRET_KEY` (and `STRIPE_APP_SECRET_KEY` if separate) | **Critical.** Full access to your Stripe account. Also, together with a founder's refresh token, mints access to their Stripe. | Stripe → Developers → API keys → **Roll key**, expire the old one **now**, paste the new one in Vercel, redeploy. | Checkout, portal and founders' timeline refreshes fail until the redeploy finishes. Load one founder's city afterwards to check refreshing still works. |
| `STRIPE_WEBHOOK_SECRET` | Medium: someone could send fake events, but the webhook re-reads every subscription from Stripe, so a fake event can't grant a plan. | Webhooks → endpoint → ⋯ → **Roll secret**. Stripe can keep the old one valid for up to 24 hours, but our server checks one secret, so: roll, update Vercel, redeploy promptly. | Deliveries fail until the redeploy; Stripe retries them, or resend. |
| `GITHUB_APP_PRIVATE_KEY` | **Critical.** With it, anyone can act as the TinyTown GitHub App and **read the code** of every repository founders connected (the App has Contents: read). | GitHub → the App's settings → **Generate a private key** (an App can have several), base64 it into Vercel, redeploy, then **delete** the leaked key on the same page. | Nothing if you add before deleting. |
| `GITHUB_APP_CLIENT_SECRET` | Medium. | App settings → **Generate a new client secret** → Vercel → redeploy → delete the old one. | Connecting GitHub, briefly. |
| `STATE_SECRET` | Low: forging connect links. | `openssl rand -base64 32` → Vercel → redeploy. | Connect flows started in the last 10 minutes fail; people press Connect again. |
| `CRON_SECRET` | Low: someone could trigger our scheduled jobs (and, if `HEALTH_SECRET` is unset, run the deep health check). | New random value → Vercel → redeploy. Vercel sends the new one on the next run. | Nothing. |
| `HEALTH_SECRET` | Low: the deep health check reports which providers work, never secrets. | New random value → Vercel → redeploy → update your uptime monitor. | The monitor, until updated. |
| Resend API key | Medium: someone can send email as you, which damages your sending reputation fast. | Resend → API Keys → create new → Vercel **and** Supabase SMTP settings → redeploy → delete old. | Email briefly. |
| Turnstile secret | Low. | Cloudflare → Turnstile → widget → rotate secret → Supabase → Bot and Abuse Protection. | Sign-in captcha checks fail until Supabase has the new one. |
| Google / GitHub sign-in client secrets | Medium. | New secret at Google Cloud / GitHub OAuth App → paste in Supabase → Sign In / Providers → delete old. | That sign-in button, briefly. |
| Sentry DSN | Low: DSNs are semi-public by design; someone could spam your error quota. | Sentry → project → Client Keys → new key, disable old. | Nothing. |
| A founder's PostHog key (stored encrypted) | Their data. | Only they can rotate it, in PostHog. Tell them (breach playbook). | Their population source until they paste a new key. |

**Message** (to founders, only if their data or access could be affected; otherwise an internal note is enough)
> On [date] we found that [which key] was exposed [how]. We replaced it within [time], and [we've found no sign it was used / here's what we know]. [What it could have accessed.] [What you need to do, if anything: e.g. reconnect Stripe in TinyTown.] I'm sorry. If you have any questions, reply to this email and I'll answer personally.

---

## A founder's Stripe connection is broken

**Symptoms**
- The founder sees "Your Stripe connection has expired. Connect Stripe again." The city doesn't update.
- The "connection broken" email went out (the email module sends it).
- Sentry or logs: `not_connected` on `/api/timeline` for that user; or "Couldn't store a rolled Stripe refresh token for user …".

**Checks** (admin console → the founder → connections)
1. **Did they uninstall the app** in Stripe (Settings → Installed apps)? Then the refresh token is dead.
2. **Is it test mode?** A test-mode connection never drives a city in production. They connected through a test link or a sandbox account.
3. **Idle for over a year?** Refresh tokens expire after a year without use.
4. **Did we change `TOKEN_ENCRYPTION_KEY`?** Every connection made before the change needs reconnecting.
5. **Did the token fail to save after a refresh** (the log line above)? Refresh tokens roll on every use; if the new one wasn't stored, the old one is already dead.
6. Is it only one founder, or many? Many at once points at us (key change, Stripe outage, a bug), not at them.

**Fix**
- For the founder: **Connect Stripe again** from the city's menu. Their city, purchases and history stay as they were; only the link to Stripe is renewed.
- If they reinstall and it fails again: check the app is published (or they're on the external test list), that `STRIPE_APP_SECRET_KEY` is the live key, and look for errors on `/api/connect/stripe/callback`.
- If many founders broke at once because of us, fix the cause first, then email everyone affected.

**Message**
> Your city lost its link to Stripe, so it's been showing the numbers from [date]. Nothing you built is lost. To reconnect, open TinyTown → [menu] → Connect Stripe and approve the TinyTown app again; it takes about a minute. [If it was us: "This was our fault: (one sentence on why). Sorry for the hassle."]

---

## Disputes and refund requests

TinyTown's policy is **no refunds; cancel any time and keep access to the end of the period you paid for**. It's shown before payment on the plan sheet, at Checkout and on the refund page. ⚖ How this applies to EU/UK consumers is an open legal question (see LAUNCH.md).

### A refund request

1. **Find the charge** in Stripe (search by email). Check: one charge or two? After a cancellation? A plan they didn't pick?
2. **Is it an exception?** Refund, without arguing, when:
   - **We charged twice** (two subscriptions from two tabs; the log says "has two live subscriptions": cancel the newer one and refund it in full).
   - **We charged after they cancelled**, or after they deleted their account.
   - **A billing bug** charged the wrong amount or plan.
   - **We failed to deliver** for a long stretch (e.g. their city couldn't load for days because of us).
   - **The law requires it** ⚖ (e.g. an EU/UK consumer withdrawing within 14 days, depending on your terms).
   - **It's cheaper and kinder than a fight:** someone who says they'll dispute a $29 charge. A dispute costs $15 that you never get back, plus another $15 to contest (together more than the charge), and counts against your dispute rate. Refunding $29 is almost always the better bet.
3. **Otherwise, decline kindly and cancel for them** so they're never charged again. Use the "Refund request" macro.
4. **Refunding** (Stripe → payment → Refund): full or partial; it takes 5–10 business days to reach them. **Refunding doesn't cancel the subscription**: cancel it too (immediately, or at period end) if that's what they want.

### A dispute (chargeback)

**Symptoms:** Stripe emails "A payment has been disputed"; Stripe → Disputes shows it. The amount plus a $15 fee has already left your balance.

**Checks**
- Reason: "fraudulent" (they say they didn't make it), "subscription canceled", "product not received", "unrecognized".
- Is it really a customer who forgot, or stolen card use? Look at the email, sign-in history, whether they connected a Stripe account (a real founder) and used the city.
- **Deadline:** usually 7–21 days depending on the network; Stripe shows the exact date. **An inquiry left unanswered can become an unwinnable chargeback.**

**Fix**
- **Is it one of the exceptions above?** Accept the dispute (Stripe → Disputes → Accept). Don't fight a case you'd have refunded.
- **Otherwise, counter with evidence** (Stripe guides you): the Checkout session showing they accepted the terms (`consent.terms_of_service: accepted` when `STRIPE_TERMS_CONSENT=1`); the refund and cancellation text shown before payment (a screenshot of the plan sheet and Checkout); their sign-in and usage (first sign-in, Stripe and GitHub connected, builds made, last seen); renewal reminder emails for yearly plans; any emails with them. Keep it factual and short.
- The card network's decision takes about **60–75 days**. You can't refund while a dispute is open.
- **Watch your dispute activity.** The industry treats anything above **0.75%** as excessive; card networks run monitoring programmes. Every dispute, won or lost, counts. More than one dispute in a week: look for a pattern (a confusing descriptor, a renewal surprise, card testing) before the next wave.
- **Card testing** (many small failed payments): Stripe Radar blocks most; a burst means turn on Turnstile if it's off and check Radar rules.

**Message** (macro: "Refund request (no refund)")
> Thanks for writing, and sorry TinyTown wasn't what you hoped. Plans are non-refundable, as the plan screen and checkout say, so I can't refund this charge. I've cancelled your plan, so you won't be charged again, and you'll keep your city until [date]. If something didn't work, I'd really like to hear what; that's the most useful thing you could tell me.

---

## Account deletion requests by email

People can delete their account themselves (TinyTown → account → Delete account). It works on any plan or none and skips the waitlist gate. In order, it cancels the Stripe plan, removes the GitHub App installation if no other TinyTown user shares it, deletes every row, then the sign-in, and it can be retried from any point. It keeps our Stripe customer and invoices, tagged `tinytown_deleted_at`. Some people will email instead.

**Checks**
1. **Is it really them?** Only act on a request that comes **from the account's own email address**. If it comes from another address, reply asking them to write from the account's address or to use the in-app button. Never delete on the word of a third party.
2. Look them up in the admin console: plan status, connections.

**Fix**
1. **Best: reply with the in-app steps.** The button does everything below, in a safe order. Do it by hand only if they can sign in nowhere (and the email really is theirs):
2. **Cancel their plan** in Stripe (Subscriptions → Cancel → immediately). No refund under the policy unless an exception applies.
3. **Delete the user** in Supabase → Authentication → Users → the user → Delete. Profiles, subscriptions, connections, saves and the cached timeline go with them (they're all deleted with the user).
4. Also remove: their **waitlist** row (keyed by email); their contact in Resend if marketing email uses audiences; their person in PostHog if you track the funnel there. ⚖ Admin audit rows and plan history keep a user id; decide whether those count as retained personal data.
5. **Tell them to uninstall** the TinyTown Stripe App (Stripe → Settings → Installed apps) and GitHub App (GitHub → Settings → Applications → Installed GitHub Apps). By hand you can't remove either for them from a dashboard. Once the account is deleted we hold no tokens, but the installs stay on their side until they remove them.
6. Stripe keeps our own payment records (charges, invoices) for accounting and legal reasons; say so plainly. ⚖
7. Reply within a few days; GDPR allows up to a month ⚖. Keep a one-line note (date, email hash or user id, "deleted on request").

**Message**
> Done: I've deleted your TinyTown account and everything we held for it: your city, saves, connections and cached metrics. Your plan is cancelled and you won't be charged again. Two things only you can do: uninstall the TinyTown app in Stripe (Settings → Installed apps) and on GitHub (Settings → Applications), if you haven't already. Stripe keeps a record of past payments, as it does for any purchase. Thanks for trying TinyTown.

---

## A data breach

Anything where someone who shouldn't could read or change personal data: a founder seeing another founder's city, a leaked service-role key, a database dump, a leaked GitHub App key.

⚖ **This needs your lawyer's judgement on the day.** The outline below is to get you moving; the legal duties depend on where you and your customers are.

**First hour**
1. **Contain:** rotate the leaked secret (table above), roll back the deploy, or take the affected route offline. Stop invites.
2. **Preserve evidence:** copy Vercel logs (they're gone after a day), Supabase logs, Sentry events, timestamps. Don't delete anything that shows what happened.
3. **Start a log:** what happened, when you found out, what you did, in UTC. You'll need it for any notice.

**First day**
4. **Scope:** which data (emails? cities? founders' revenue history? Stripe or PostHog credentials? repository access?), which people, which time window. Check provider logs for actual use.
5. **Decide who has to be told** ⚖:
   - **EU/UK (GDPR):** the supervisory authority within **72 hours** of becoming aware, unless the breach is unlikely to risk people's rights; affected people "without undue delay" if the risk is high.
   - **US:** state laws vary in what counts and how fast (often "without unreasonable delay", some with fixed deadlines).
   - **Providers:** if founders' Stripe access could be misused, contact Stripe support; if the GitHub App key leaked, GitHub. Founders whose credentials or repository access were exposed need to know so they can act (uninstall and reinstall, rotate PostHog keys).
6. **Fix the cause** and confirm the fix.

**Notification outline** (to affected founders)
> **Subject: Something went wrong with your TinyTown data**
>
> On [date], we found that [what happened, one or two plain sentences]. It affected [who] between [start] and [end].
>
> **What was involved:** [exactly which data; also say what was *not* involved, e.g. "No card details: we never have them; Stripe does."]
>
> **What we've done:** [contained how, when; keys rotated; fix shipped].
>
> **What you should do:** [specific steps, e.g. "Reconnect Stripe in TinyTown", "Rotate your PostHog API key", "Review your GitHub App installations"; or "Nothing; we're telling you because you should know."]
>
> I'm sorry. You trusted TinyTown with your startup's numbers and we let you down. If you have questions, reply to this email; I'll answer each one myself.
>
> [Name], TinyTown · [postal address]
