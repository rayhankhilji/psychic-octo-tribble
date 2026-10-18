# TinyTown go-live plan

This is the plan for opening TinyTown to the 10,000-person waitlist: what to buy, which provider limits to raise, the week before, launch day, the invite waves, and the week after. It assumes the setup in `docs/SETUP.md` is done and working in test mode.

Companion docs: `docs/RUNBOOK.md` (what to do when something breaks), `docs/FAQ.md` (customer answers), `docs/launch/` (emails, posts, support macros).

Prices and limits below were checked on 2026-10-13 against each provider's own pages (links in [Sources](#sources)). They change; glance at the link before you pay.

> **Marked ⚖ = needs your legal or tax judgement.** They're collected in [Needs your judgement](#needs-your-legal-or-tax-judgement) at the end. Nothing here is legal or tax advice.

---

## The short version

1. **Start the long-lead items now** (at least 14 days out): submit the Stripe App for review, activate live Stripe, buy the domain, and start warming up the email domain. Each one can hold up launch on its own.
2. **Buy:** Vercel Pro, Supabase Pro, Resend Pro, a domain. Sentry and Turnstile start free. Fixed cost is roughly **$66–97 a month** plus Stripe's per-payment fees.
3. **Raise:** Supabase's auth email limit (it's 30 an hour once custom SMTP is on), and check Resend's warm-up pace. Everything else has headroom at this size.
4. **Let people in in waves** with `ACCESS_MODE=waitlist`: 25 friends, then 500, 1,500, 3,000 and the rest over four or five days, checking the numbers between each.
5. **Don't open a paid wave until the Stripe App is published.** Before then, only 25 Stripe accounts can connect, and with no refunds you can't take money for a city that can't read revenue.

---

## Long-lead items (T-14 or earlier)

| Item | Why it can't wait | What to do |
|---|---|---|
| **Stripe App review** | Stripe says to expect an approval or feedback email **4 business days** after you submit, and every resubmission is reviewed again. Until it's published, the public install link doesn't work at all and the external test is capped at **25 testers**. | Submit by T-14 so two rounds fit. See [The Stripe App review](#the-stripe-app-review-risk). |
| **Live Stripe account** | You can't take live payments, or publish the app, until the account is activated. | Activate it, set the statement descriptor (e.g. `TINYTOWN`), public business details, support email and a terms and privacy URL. |
| **Domain and DNS** | Stripe, the Stripe App manifest, the GitHub App, Supabase and Turnstile all store the address; changing it later means redoing all of them. | Buy it, add it in Vercel → Settings → Domains, then update every place that stores the address (SETUP.md, section 6, step 5). |
| **Email domain warm-up** | A brand-new sending domain should start at about **150 emails a day**, reaching **2,000 a day by day 7** (Resend's own schedule). You'll need several thousand a day in launch week. | Add the domain to Resend now, set SPF, DKIM and DMARC, and start sending real mail. See [Email](#email-resend-and-supabase-auth). |
| **Google sign-in** | Google may want to verify the app before it shows your name and logo on the consent screen. | Fill in the OAuth consent screen with the production domain, privacy and terms links now. |
| **Legal pages** | Stripe's Checkout terms checkbox, the Stripe App listing, Google's consent screen and the customer portal all need live URLs for terms, privacy and refunds. | Get the ⚖ items reviewed, publish `/legal/*.html`. |

---

## What to buy

| Service | Plan | Price | Notes |
|---|---|---|---|
| **Vercel** | Pro | **$20/month** per developer seat, with $20 of usage credit included | Hobby is "for personal, non-commercial use", so a paid product needs Pro. New teams get a default on-demand budget of $200. Pro keeps runtime logs for **1 day** (30 with the Observability Plus add-on). |
| **Supabase** | Pro | **from $25/month**, includes $10 of compute credit (covers Micro) | 100,000 monthly active users, 8 GB disk, 250 GB egress, daily backups kept 7 days. Free projects pause after a week idle, so Pro is not optional. Spend cap is on by default. |
| Supabase compute | Small for launch week | ~$15/month (so about +$5 after the credit) | Micro is 1 GB RAM; Small is 2 GB. Changing compute restarts the database, so do it at T-3, not mid-wave. Drop back later if the graphs are quiet. |
| **Resend** | Pro | **$20/month for 50,000 emails** | Free is capped at 100 a day, which the warm-up alone exceeds. 50,000 covers the announcement, every invite, sign-in links and lifecycle mail for launch month. Overage is $0.90 per 1,000. |
| **Sentry** | Developer (free) to start | $0: one user, 5,000 errors a month | Team is $26/month (billed annually) if you outgrow 5,000 errors or add a person. |
| **Cloudflare Turnstile** | Free | $0 | Unlimited challenges, up to 20 widgets, 10 hostnames per widget. |
| **Domain** | | about $10–11/year for a `.com` at an at-cost registrar; other endings cost more | Buy it yourself; nothing here buys one for you. |
| **PostHog** (your own funnel) | Free tier | $0 to start | Optional. |
| **Stripe** | Standard pricing | per payment, below | No monthly fee. |
| **Stripe Tax** ⚖ | Optional | **0.5% per transaction** where you're registered (no-code) | Only if you decide to collect tax. See below. |

**Fixed monthly:** Vercel $20 + Supabase $25 (+$5 for Small) + Resend $20 + Sentry $0–26 + domain ~$1 ≈ **$66–97**.

### What Stripe takes per payment

US card pricing: **2.9% + 30¢** per successful charge, **+1.5%** for international cards, **+1%** if currency conversion is needed, plus **Stripe Billing at 0.7%** of subscription volume.

TinyTown is **$29 a year**, one charge a year:

| | $29 yearly |
|---|---|
| Card fee (2.9% + 30¢) | $1.14 |
| Billing (0.7%) | $0.20 |
| **Total, US card** | **$1.34 (4.6%)** |
| International card (+1.5%) | $1.78 |
| + Stripe Tax, if used (0.5%) | +$0.15 |

Local currencies come from **Adaptive Pricing**, which costs you nothing: the buyer pays Stripe's 2–4% conversion inside the exchange rate (and can choose to pay in USD instead). You're paid in USD either way.

A dispute costs **$15** when it arrives (never refunded) and another **$15** if you contest it (refunded if you win). On a $29 charge, fighting a dispute costs more than the charge. That shapes the refund exceptions in `docs/RUNBOOK.md`.

---

## Provider limits to raise or check before launch

The numbers that matter at this size, what TinyTown needs, and what to do.

### Supabase Auth

| Limit | Default | TinyTown needs | Action |
|---|---|---|---|
| Emails sent, **built-in** mailer | **2 an hour**, team members only | Thousands a day | Never launch on it. Set up custom SMTP (Resend) at T-7. |
| Emails sent, **custom SMTP** | **30 an hour** once SMTP is saved | A wave chunk of 250 invites can bring 250+ sign-in emails in an hour, plus retries | **Raise it** in Authentication → Rate Limits. Set it a little above your planned hourly invite chunk (e.g. **500/hour** for launch week). It's a safety cap, so don't set it to infinity. |
| Sign-ups and sign-ins per IP | 30 per 5 minutes | Fine, unless a whole coworking space signs in at once | Leave it. |
| Magic link per user | 1 per 60 seconds | Fine | Leave it. The sign-in screen should say "you can ask again in a minute". |
| Token refresh per IP | 150 per 5 minutes | Fine | Leave it. |

Also set in Supabase: Site URL and redirect URLs on the production domain; the Turnstile **secret** under Authentication → Bot and Abuse Protection (the site key goes in `TURNSTILE_SITE_KEY`); sign-in email templates (the email module ships them).

### Supabase database

TinyTown talks to Postgres through Supabase's REST API (PostgREST), not direct connections, so Vercel functions don't each hold a connection. The pressure point is CPU and memory, not connection count.

| Compute | RAM | Max DB connections | Max pooler clients |
|---|---|---|---|
| Micro (included) | 1 GB | 60 | 200 |
| Small (~$15) | 2 GB | 90 | 400 |
| Medium (~$60) | 4 GB | 120 | 600 |

Action: move to **Small at T-3** and watch Reports → Database (CPU, memory) during each wave. Medium is one click away if CPU stays above 70%.

### Vercel

| Limit | Pro | TinyTown needs | Action |
|---|---|---|---|
| Function concurrency | Auto-scales to **30,000** | Far less | Nothing. |
| Max duration | **300 s default**, 800 s max | API calls take seconds; the slowest is a first timeline build (a founder with many subscriptions) | Nothing. |
| Request/response body | 4.5 MB | Timelines are well under | Nothing. |
| Runtime log retention | **1 day** | You'll want a week of history around launch | Rely on Sentry for errors, or add Observability Plus for launch month (30 days). |
| On-demand budget | $200 by default, with alerts | | Set alerts at 50/75/100%. **Don't** turn on "pause projects at 100%" during launch week: it takes the site down. |
| Cron | Hourly needs Pro | `/api/cron/hourly`, `/daily`, `/weekly` | Check they're listed under Settings → Cron Jobs after the production deploy. |

Changing an environment variable doesn't change the running site: **redeploy** after every change (Deployments → ⋯ → Redeploy).

### Stripe

| Limit | Value | TinyTown | Action |
|---|---|---|---|
| Global API rate (live) | **100 requests/second** per account | Checkout and portal sessions, webhook reads | Nothing at this size. |
| Per endpoint | **25 requests/second** | e.g. creating Checkout Sessions | Nothing: 25 checkouts a second is beyond any wave. |
| Concurrency (live) | **50 in-flight requests** | | Nothing. |
| Sandbox/test mode | **25 requests/second** global | Load tests against test mode will hit this | Load-test against the fake providers (`tools/`), not Stripe test mode. |
| Read allocation | Average 500 reads per transaction over 30 days, minimum 10,000 a month | Founders' timelines list subscriptions (100 per request) on refresh | Keep timeline refreshes cached (15 minutes today). |
| Founders' OAuth tokens | Access token 1 hour; refresh token 1 year, rolled on every use | The server refreshes as needed | A founder idle for a year must reconnect. |

Also in the Stripe Dashboard: turn on **Smart Retries** and the failed-payment emails, and **upcoming-renewal reminder emails** (Settings → Billing → Subscriptions and emails) so every customer hears before their $29 renewal. That reduces "I didn't know it renewed" disputes. ⚖

### GitHub App

| Limit | Value | TinyTown |
|---|---|---|
| Per installation | **5,000 requests/hour**, growing with repositories and users to a cap of 12,500 (15,000 for Enterprise Cloud orgs) | A timeline build is about 16 requests (up to 10 pages of commits, 5 of releases, a token), at most every 15 minutes per founder. Two founders in the same GitHub org share one installation. Plenty. |
| OAuth token requests, app-wide | **2,000 an hour** | Each "Connect GitHub" does one. This is the only GitHub ceiling a wave could touch: a wave chunk of 2,000 people all connecting GitHub in the same hour. Chunking invites keeps you far below it. |
| Secondary limits | 100 concurrent requests; 900 points a minute per REST endpoint | Fine. |

No review needed; just make sure the App is set to install on **any account**.

### Email (Resend and Supabase Auth)

| Limit | Value | Action |
|---|---|---|
| Resend API | **10 requests/second** per team | The email module should pace batches; ask Resend support to raise it if you need more. |
| Resend bounce rate | Keep **under 4%** or sending may be paused | Watch the Metrics page during waves. |
| Spam complaints | Resend's warm-up guide: keep **under 0.08%**. Gmail: over 0.1% hurts inbox placement; over 0.3% and bulk senders lose mitigation. | Make every email expected and easy to leave. |
| Gmail/Yahoo bulk senders (5,000+/day) | SPF, DKIM and DMARC; one-click unsubscribe on marketing mail | The announcement is marketing mail: it needs the List-Unsubscribe header (Resend Broadcasts adds it) ⚖ and a postal address (CAN-SPAM) ⚖. |

**Warm-up (Resend's schedule for a new domain):** up to 150 on day 1, 250, 400, 700 (50/hour), 1,000 (75/hour), 1,500 (100/hour), 2,000 on day 7 (150/hour). For an established domain it's 1,000 on day 1 up to 10,000 on day 7.

What that means for TinyTown:

- **Use subdomains:** sign-in mail from `auth.YOUR-DOMAIN` (Supabase SMTP via Resend) and invites and lifecycle mail from `mail.YOUR-DOMAIN`, as Supabase recommends, so a marketing hiccup can't stop sign-in links.
- **Warm up for at least a week before Wave 1**, with real mail people expect: the announcement, sent oldest-signups-first in daily batches that follow the schedule above.
- **If your waitlist tool (the one that collected the 10,000) has its own sending reputation**, send the announcement from there instead and use Resend only for invites and sign-in. That's the lowest-risk option.
- **Point people to Google or GitHub sign-in** in the invite. They need no email at all.
- **Send each wave in hourly chunks**, which also gives you time to stop the line. Each invite brings a sign-in email or two, so count both against the warm-up's hourly pace: start at 100 invites an hour and step up to 250 only while bounces and complaints stay clean. Resend's warm-up calculator extends the schedule past day 7 for your target volume.

### Cloudflare Turnstile

Free plan: unlimited challenges, up to 20 widgets, 10 hostnames per widget. Tokens are valid for 300 seconds and single use. Create one widget and add the production domain and your project's `your-project.vercel.app` address (not all of `vercel.app`). Put the site key in `TURNSTILE_SITE_KEY` and the secret in Supabase.

---

## T-7 to T-1

**T-7**
- [ ] Vercel Pro, Supabase Pro, Resend Pro paid. Sentry project created.
- [ ] Production environment variables set in Vercel with **live** keys, marked Sensitive (SETUP.md table plus `ACCESS_MODE=waitlist`, `STRIPE_TERMS_CONSENT=1`, `ADMIN_EMAILS`, `CRON_SECRET`, `HEALTH_SECRET`, `SUPPORT_EMAIL`, `TURNSTILE_SITE_KEY` and the email, Sentry and PostHog keys from `.env.example`). `ALLOW_TEST_MODE` and `STRIPE_APP_INSTALL_URL` **unset** (unless you're on the external test, below).
- [ ] All migrations run on the production database, in order (`supabase/migrations/0001…`). Check every table has RLS on (Database → Tables).
- [ ] Supabase: custom SMTP via Resend on `auth.YOUR-DOMAIN`; auth email limit raised; Turnstile secret set; Site URL and redirects on the real domain.
- [ ] Stripe live: `node tools/stripe-setup.mjs --live` (product, the **$29 yearly** price, **no trial**, no monthly price; webhook endpoint on the real domain with all nine events; customer portal with cancel at period end, card and invoices, no plan switching); `STRIPE_PRICE_YEARLY` set and **`STRIPE_PRICE_MONTHLY` unset**; the first-year offer's coupon made (`tinytown_first_year_9`, 68.97% off once) and `STRIPE_OFFER_COUPON` set, after migration 0009; Adaptive Pricing on; renewal reminder emails on; branding; Checkout settings (below).
- [ ] Email warm-up started. Announcement batch 1 sent.
- [ ] Stripe App: approved, or in review with a fallback chosen.

**T-5**
- [ ] **A real end-to-end run in live mode with your own card**: sign in (magic link, Google, GitHub), connect Stripe and GitHub **before paying** (no card asked), "Build my city", check the paywall shows your real MRR, close it, check the $9 first-year offer (and that Checkout says $9 today, then $29 a year), pay (in a second currency too, with a `+location_FR` test email in test mode), watch the grand opening, buy something, open the portal, cancel, export, delete. Then refund yourself from the Dashboard. A second account should see the offer once; after 48 hours (or in test mode, with `offer_shown_at` moved back two days in the SQL editor) the paywall is $29 again.
- [ ] `GET /api/config` shows `"hosted": true`, both plans, `"access": "waitlist"`, and no secrets.
- [ ] `GET /api/health` and the deep check (`/api/health?deep=1` with the health secret as a bearer token) are all `ok`.
- [ ] Sentry receives a test error from the browser and from the API.
- [ ] Stripe Dashboard → Webhooks → your endpoint: every delivery from the test run is `200`.

**T-3**
- [ ] Supabase compute to Small. Confirm a backup exists (Database → Backups).
- [ ] Run the load test (`tools/loadtest.mjs`, with the fake providers in `tools/fake-providers.mjs`) against a preview deploy, never against live Stripe; note p95 latency and error rate as your baseline.
- [ ] Import the waitlist from your CSV export, keeping the sign-up date column so the queue is fair: `node --env-file=.env tools/import-waitlist.mjs waitlist.csv --dry-run`, then without `--dry-run` (with production Supabase values in that `.env`). It's safe to run twice. Spot-check the count in the admin console. Prune obviously dead addresses first: bounces on invites hurt the whole domain.
- [ ] Freeze: no feature merges to `main` from here, only fixes.

**T-2: Wave 0 (25 friends)**
- [ ] Invite up to 25 people you know who run a startup with real Stripe revenue. Ask them to pay with their own card, connect, and report anything odd.
- [ ] Watch their sessions in Sentry and the admin console. Fix what they find.

**T-1**
- [ ] Go/no-go review of Wave 0 against the criteria below.
- [ ] Pre-write the launch-day posts (`docs/launch/social.md`) and the support macros into your inbox tool.
- [ ] Bookmark the [watch list](#the-watch-list). Clear your calendar. Sleep.

---

## The waves

Everyone is invited from the admin console ("invite next N", oldest sign-ups first; preview first to see who's next); each invite sends the email module's invite email. If a batch is interrupted, the console can send the invites that were missed. Paying founders always get through the gate, so closing it again never locks anyone out who has paid. `ACCESS_MODE=waitlist` keeps everyone else out (they get a polite "not yet" and join the list).

| Wave | When | Size | Running total | Send as |
|---|---|---|---|---|
| 0 | T-2 | up to 25 | 25 | by hand |
| 1 | Launch day, morning | 500 | ~525 | 5 chunks of 100, one an hour |
| 2 | L+1 | 1,500 | ~2,025 | hourly chunks, 100 stepping up to 250 |
| 3 | L+2 or L+3 | 3,000 | ~5,025 | 12 chunks of 250, over the day |
| 4 | L+4 or L+5 | the rest (~5,000) | ~10,000 | chunks of 250–500 |
| Open | after Wave 4 holds for 24 hours | everyone | | set `ACCESS_MODE=open`, redeploy |

Shift the dates rather than the sizes if a check fails. One bad day costs a day; a bad wave costs trust with thousands of people.

### Go/no-go between waves

Look at the last 12 hours (24 for the step to "open"). Every line must hold to go on.

| Check | Go | Where |
|---|---|---|
| API errors | 5xx under **1%** of `/api` requests; no new Sentry issue affecting more than a handful of people | Vercel → Observability; Sentry → Issues |
| Payments match access | Every paid Checkout has an active plan in TinyTown, and nobody has access without paying (comps aside) | Admin console vs Stripe → Subscriptions |
| Checkout | Zero 5xx on `/api/billing/checkout`; no "I paid but…" emails | Vercel logs; inbox |
| Webhooks | **Zero** failed or pending deliveries | Stripe → Webhooks → your endpoint → Event deliveries |
| Connecting | Most Stripe and GitHub connects succeed; no repeated `connect_error` reason | Sentry; admin console |
| Email | Bounce rate under **2%** (Resend pauses at 4%); complaints under **0.08%**; your seed inboxes (Gmail, Outlook, iCloud) get invites and sign-in links in the inbox within a minute | Resend → Metrics; your own inboxes |
| Support | Every message answered within 24 hours; nothing open older than that; no single problem reported more than five times | Support inbox |
| Database | CPU under 70%; no auth 429s in the logs | Supabase → Reports, Logs |
| Disputes | Zero. Any dispute gets read before the next wave | Stripe → Disputes |

---

## Launch day

### Who watches what

You're one person, so this is a loop, not a rota. After each invite chunk, and every 30 minutes for the first four hours, walk the watch list top to bottom. If a friend is helping, give them the support inbox and the macros; keep the dashboards yourself.

### The watch list

| Where | What you're looking for |
|---|---|
| `GET /api/health?deep=1` with `Authorization: Bearer <HEALTH_SECRET>` (or `CRON_SECRET`) | Every check `ok`. A failing one tells you where to look next. Worth pointing a free uptime monitor at it. |
| Sentry → Issues (sort by "first seen") | New issues since the last chunk; anything touching billing, webhook or connect. |
| Vercel → Logs (filter: `/api`, status 5xx; then 429) | Bursts of 5xx; a flood of 429s (see RUNBOOK). |
| Stripe → Webhooks → Event deliveries | All `Delivered`. |
| Stripe → Payments and Subscriptions | New payments look normal; no doubles; no disputes or early fraud warnings. |
| Supabase → Reports → Database, Auth logs | CPU and memory; auth email 429s or SMTP errors. |
| Resend → Metrics / Logs | Delivered vs bounced vs complained for the last chunk. |
| Support inbox | Same complaint twice = look now. |
| Status pages | [Vercel](https://www.vercel-status.com), [Supabase](https://status.supabase.com), [Stripe](https://status.stripe.com), [GitHub](https://www.githubstatus.com), [Resend](https://resend-status.com), [Cloudflare](https://www.cloudflarestatus.com). |

### Stop the line

Stop inviting immediately, and open the matching RUNBOOK page, if any of these happen:

- **Money is wrong:** a charge without access, access without a charge, or a double charge.
- **Someone sees data that isn't theirs.** Treat as a breach until proven otherwise.
- API 5xx above **5% for 10 minutes**, or any 5xx burst on checkout or the webhook.
- Webhook deliveries failing for more than **15 minutes**.
- Sign-in links not arriving at your seed inboxes, or Supabase auth 429s.
- Resend bounce rate above **4%** or complaints above **0.1%**.
- A secret shows up anywhere it shouldn't (a log, a screenshot, a repo).
- Supabase, Vercel or Stripe reports a major incident.

### How to pause

1. **Stop inviting.** Nothing more goes out until you press "invite next" again. This alone stops new people arriving.
2. **If it's the code:** Vercel instant rollback to the last good deployment (RUNBOOK, "A bad deploy").
3. **If you need to close the door** after going open: set `ACCESS_MODE=waitlist` in Vercel and redeploy. People already invited (and paying) keep their access; everyone else sees the waitlist message.
4. **Tell people.** A short post or status note ("We've paused invites while we fix X. Nobody has been charged for anything they can't use.") beats silence. Only say that last sentence if it's true.

---

## T+1 to T+7

- **Daily, 15 minutes:** the go/no-go table, the support inbox, Stripe disputes and early fraud warnings.
- **L+1:** reply to every launch-day email. Write down the three most common questions and add them to `docs/FAQ.md`.
- **L+2:** check the first hourly, daily and weekly cron runs completed (Vercel → Cron Jobs; the data pipelines' own logs).
- **L+3:** reconcile Stripe against the database: active Stripe subscriptions = paying founders in the admin console. Investigate every mismatch.
- **L+5:** first look at the funnel ⚖: invited → signed in → paid → connected Stripe → first build. Use the real numbers only.
- **L+7:** decide Supabase compute (stay on Small or drop to Micro), Sentry plan, Vercel log retention. Turn the Supabase auth email limit down to the level you actually used plus headroom. Update `docs/HANDOFF.md` "Current state".
- **Before the first renewals (day 25 or so):** confirm Smart Retries and failed-payment emails are on, and that a `past_due` founder still sees their city (they do: `past_due` counts as paid).

---

## Pricing page and checkout copy

The plan sheet (`src/ui/plans.ts`) already says it well. It shows, before the button:

> **No free trial.** The demo is free to explore for as long as you like.
>
> Payment is handled by Stripe. Plans renew automatically; cancel any time in Manage billing and keep your city until the period you paid for ends. Payments are non-refundable.

and links Terms, Privacy and the Refund policy. Keep all of that. Two small asks:

1. **Put the yearly total next to the price**, not only "$2.42 a month": "**$29 today**, then every year until you cancel." People dispute charges they didn't expect. (Done: the plan ticket's stub says "Today $29 · Then $29 every year, until you cancel".)
2. **Say "non-refundable" next to the button as well as in the fine print**, e.g. under the button: "Renews automatically. Cancel any time. No refunds." ⚖

**Stripe Checkout.** The billing module already has switches: `STRIPE_TERMS_CONSENT=1` adds the required terms checkbox (`consent_collection[terms_of_service]=required`), and `STRIPE_AUTOMATIC_TAX=1` turns on Stripe Tax ⚖. **Set `STRIPE_TERMS_CONSENT=1` for launch.** The custom wording below isn't in the code yet (a small change in the billing module's `checkoutParams`); until it is, Stripe shows its default checkbox text, which links your terms but doesn't mention refunds.

- With the checkbox, `custom_text[terms_of_service_acceptance][message]`:
  > I agree to the [Terms](https://YOUR-DOMAIN/legal/terms.html). My plan renews automatically until I cancel, and payments are non-refundable ([refund policy](https://YOUR-DOMAIN/legal/refunds.html)).
- `custom_text[submit][message]`:
  > Cancel any time from Manage billing in TinyTown. You keep your city until the end of the period you've paid for.
- In Stripe → Settings → Checkout: turn on **Legal policies** and **Return and refund policies**, and set the refund policy to "no refunds" with the link. Public details must have the terms and privacy URLs first.
- Statement descriptor `TINYTOWN` (Settings → Business → Public details) so the bank line is recognisable. Unrecognised descriptors are a common reason for "fraud" disputes.

**Customer portal:** cancellation at period end, a cancellation reason survey (it's free feedback), invoices on, plan switching off (there's one plan).

---

## The Stripe App review risk

**The constraint.** Founders connect Stripe through the TinyTown Stripe App. Until Stripe approves and you publish it:

- The **public install link doesn't work** for anyone except Stripe's reviewers.
- The **external test** lets other accounts install an unpublished version. It works for live accounts when the app was uploaded from a live account, and OAuth apps get a separate **live-mode** test link. It's capped at **25 testers per app**, Stripe asks that it be used for testing only, testers need the Apps administrator role on their Stripe account, and you must tell them the app is still in development and hasn't been reviewed.
- Stripe says to expect a decision **4 business days** after submitting, and any change to the app or listing goes through review again.

**What review needs** (so it passes first time):

- `stripe-app.json` with **no localhost or placeholder redirect URIs** (remove the local test entry SETUP.md mentions before uploading the review version).
- Listing: name (35 characters, can't contain "Stripe", "app", "free" or "paid"; "TinyTown" is fine), a 300×300+ icon matching the manifest, "Built by" ⚖, subtitle and up to three key features with images at least 1,600 px wide that **show no real customer data** (use the demo), pricing "paid subscription required" with a link to the pricing page, a support email with a response time, privacy policy URL.
- The install URL you give is your site (`https://YOUR-DOMAIN/`), which starts the OAuth flow with the **public** link from the Settings tab, not the External test link.
- **Test credentials** for a TinyTown account, without two-factor and not a real customer's account. TinyTown has no passwords, so: make a dedicated Google account for the reviewer, invite it and **comp it** in the admin console, and put its login in the form. (Google sometimes challenges new sign-ins; as a fallback, write in the notes: "If Google blocks the sign-in, reply with any email address and we'll invite and comp it within one business day.")
- Testing guidance: sign in → you're already on a plan → Connect Stripe → approve → your city. Say that an account with no subscriptions shows a city at $0 MRR, which is correct.

**Mitigation.** Submit by **T-14**. Then:

- **If it's approved in time:** publish, remove `STRIPE_APP_INSTALL_URL`, launch as planned.
- **If it isn't (recommended fallback):** run Wave 0 on the external test. Set **Link access** to invited users only, invite up to 25 founders by their Stripe account, and set `STRIPE_APP_INSTALL_URL` to the **live-mode** External test authorize link without its query string, with the live secret key. Hold Waves 1+ until the app is published. Tell the waitlist plainly in the announcement email that invites start when Stripe finishes reviewing the app.
- **Not recommended:** opening paid waves with GitHub-only cities while Stripe is pending. The economy runs on MRR; a GitHub-only city has no income beyond the starting grant, and with no refunds people would pay for a game they can't really play yet.

When the app is published, testers on the External test version may need to uninstall it and install the published one (Stripe requires uninstalling one to install the other). If their connection breaks, the "connection broken" email and in-app prompt cover it; tell them in advance anyway.

---

## Needs your legal or tax judgement

These need you (and, where it matters, a lawyer or accountant). The docs and copy are written so they hold either way, but some wording should change with your answers.

1. **⚖ No refunds and consumer law.** In the EU and UK, consumers normally get a 14-day right to withdraw from online contracts. For digital services the rules on losing that right are narrower than for digital content, and courts have read them strictly. A blanket "no refunds" may not hold for EU/UK consumers. Options: (a) state that TinyTown is for business use (founders buying for their company), (b) collect express consent to start immediately and the acknowledgement Checkout allows, (c) honour withdrawal requests within 14 days for consumers anyway. Decide before launch; the refund page and macros should match.
2. **⚖ Auto-renewal laws (US states, California especially).** Clear renewal terms before purchase, affirmative consent, an acknowledgement email that says how to cancel, easy online cancellation (the Stripe portal does this), and possibly reminders before yearly renewals. Turn on Stripe's renewal reminders regardless.
3. **⚖ Sales tax and VAT.** Whether to turn on Stripe Tax (0.5% per transaction where registered) and whether $29 includes tax. Non-EU businesses selling digital services to EU consumers generally have no threshold: VAT is due from the first sale (the Non-Union OSS scheme handles the filing). The UK is similar for non-UK sellers. US states each set their own rules on SaaS and their own thresholds. Stripe Tax's threshold monitoring shows where you're getting close.
4. **⚖ Privacy.** The privacy policy has to name what's collected and who processes it (Vercel, Supabase, Stripe, Resend, Sentry, Cloudflare, PostHog if used, Google and GitHub for sign-in), where data is stored, how long it's kept after cancelling, and how to export and delete. Sign each provider's DPA. Breach notification duties (GDPR's 72 hours, US state laws) are in RUNBOOK.
5. **⚖ Marketing email.** That the waitlist sign-up covers the announcement; a physical postal address in the announcement footer (CAN-SPAM); one-click unsubscribe.
6. **⚖ Who the merchant is.** The legal entity on the Stripe account, the Stripe App's "Built by" line, and the terms should all name the same one.
7. **⚖ Refund exceptions.** RUNBOOK suggests refunding double charges, billing errors and charges after a confirmed cancellation. Put "except where we charged you in error or the law requires it" in the terms so the exceptions don't contradict the policy.
8. **⚖ Data after cancelling.** How long a cancelled founder's city and connections are kept. FAQ says "kept until you delete your account" and marks it for you to confirm.
9. **⚖ Introductory offer (new, 2026-10-15).** The terms now say a first-year price may be offered once and renews at the standard price (`/legal/terms.html` §3, flagged in the page source). Check the wording, and the renewal-disclosure rules for discounted first periods (California's auto-renewal law asks for the price after the offer to be stated clearly before purchase: the offer card, Checkout and the terms all say "$9 for your first year, then $29 a year"), and whether EU/UK price-reduction rules apply to how it's presented.

---

## Sources

Checked 2026-10-13.

- Vercel: [pricing](https://vercel.com/pricing), [function limits](https://vercel.com/docs/functions/limitations), [runtime logs](https://vercel.com/docs/logs/runtime), [instant rollback](https://vercel.com/docs/instant-rollback)
- Supabase: [pricing](https://supabase.com/pricing), [compute sizes](https://supabase.com/docs/guides/platform/compute-and-disk), [auth rate limits](https://supabase.com/docs/guides/auth/rate-limits), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [backups](https://supabase.com/docs/guides/platform/backups)
- Stripe: [pricing](https://stripe.com/pricing), [rate limits](https://docs.stripe.com/rate-limits), [webhooks](https://docs.stripe.com/webhooks), [Checkout text and policies](https://docs.stripe.com/payments/checkout/custom-components?payment-ui=stripe-hosted), [disputes](https://docs.stripe.com/disputes/how-disputes-work), [dispute rates](https://docs.stripe.com/disputes/measuring), [renewal emails](https://docs.stripe.com/billing/revenue-recovery/customer-emails), [Tax monitoring](https://docs.stripe.com/tax/monitoring)
- Stripe Apps: [external testing](https://docs.stripe.com/stripe-apps/test-app), [publishing and review](https://docs.stripe.com/stripe-apps/publish-app), [OAuth](https://docs.stripe.com/stripe-apps/api-authentication/oauth)
- GitHub: [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- Resend: [pricing](https://resend.com/pricing), [API rate limit](https://resend.com/docs/api-reference/rate-limit), [warming up](https://resend.com/docs/knowledge-base/warming-up), [quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- Sentry: [pricing](https://sentry.io/pricing/)
- Cloudflare Turnstile: [plans](https://developers.cloudflare.com/turnstile/plans/), [server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- Gmail: [sender guidelines](https://support.google.com/a/answer/81126)
- EU VAT for non-EU sellers: [ICAEW guide](https://www.icaew.com/technical/tax/tax-faculty/taxguides/2020/taxguide-2020-new-vat-ecommerce-rules-in-eu-from-1-july-2021-how-will-they-affect-uk-businesses)
