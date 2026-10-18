# Connectors: how a founder's data gets into TinyTown

What each connection reads, exactly; why Stripe and GitHub use our own apps rather than Composio; where Composio does help; and what the setup screens show when something fails. Researched 2026-10-14 against Composio's, Stripe's, GitHub's, PostHog's and Google's documentation (links at the end). The code is the source of truth: `server/stripe-app.ts`, `server/github-app.ts`, `server/users.ts`, `server/posthog.ts`, `server/sources.ts`, `server/composio.ts`.

## The recommendation

| Data | Use | Why |
|---|---|---|
| **Stripe** (MRR, paying customers) | **Our Stripe App** (native, the default) | It's the only way to get **read-only** access to a founder's Stripe without a pasted key. Stripe shows founders our app, reviewed and listed by Stripe, asking only to read subscriptions and prices. Through Composio, Stripe would ask them to grant full **read and write** access to their account. |
| **GitHub** (releases, commits) | **Our GitHub App** (native, the default) | Read-only on the repositories the founder picks. Composio's GitHub connection is an OAuth App with the `repo` scope: read and write to every repository the founder can reach, private code included. |
| **PostHog** (monthly active users) | **Native** (key stored encrypted by us) | PostHog uses a personal API key either way. Composio would only add a hop and a second company holding the key. |
| **Google Analytics 4** (monthly active users) | **Composio**, behind `CONNECT_VIA=composio` | No native connector exists, and Google's `analytics.readonly` scope needs an OAuth app verified by Google. Composio already has one. Built and tested; off until the owner adds a key (see "Turning Composio on"). |
| No analytics at all | **Paying customers** (the default) or **a number you set** | Nothing to connect. Step 3 says so first: "No analytics? Your paying customers are your residents." |

The owner asked whether Composio's size makes founders trust it more. On Stripe's own consent screen, founders see the requesting app's name and the exact permissions it wants. A Stripe-reviewed Marketplace app that can only read subscriptions is the strongest signal Stripe offers. A Composio-managed Stripe connection would show "Composio" asking for full access to their Stripe account. Most founders haven't heard of Composio, which is a developer tool for AI agents, and those who have know it as a way to let agents *act* on their accounts. So for Stripe and GitHub, the native apps are the better trust story as well as the better data story. For GA4, Composio is worth it.

## Does Composio give us the data we need? Yes. Can it give it read-only? No.

The question we started with was whether Composio gives us the data we need. It does, because Composio's **proxy** (`POST /api/v3.1/tools/execute/proxy`) makes any request we name, using the founder's credentials, and returns the provider's **raw** status and body. We don't depend on Composio's named tools, which reshape parameters. For example, its docs don't confirm that `STRIPE_LIST_SUBSCRIPTIONS` takes `status=all`. `server/composio.ts` uses the proxy, so its output is byte-for-byte what the native fetchers get, and the rest of the pipeline is unchanged.

What the pipeline needs, and whether the proxy can get it:

| Pipeline input | Exact call | Fields read | Composio proxy |
|---|---|---|---|
| Every subscription, any status, the whole history | `GET https://api.stripe.com/v1/subscriptions?status=all&limit=100&starting_after=…`, up to 50 pages (5,000 subscriptions) | `id`, `customer`, `status`, `start_date`, `trial_end`, `ended_at`, `currency`, `items.data[].quantity`, `items.data[].price.unit_amount`, `.currency`, `.recurring.interval`, `.recurring.interval_count` | Yes, raw, cursor paging works (tested) |
| Paying customers per day | Derived from the above (distinct `customer` on active spans) | | Yes |
| Discounts | Not modelled today (`src/data/stripe.ts`: MRR uses each subscription's current prices) | | n/a |
| Live or test mode | Native: the OAuth token's `livemode`. Composio: `GET /v1/balance` → `livemode` | | Yes |
| Account name | Native: not available with our two permissions. Composio: `GET /v1/account` → `settings.dashboard.display_name` | | Yes (only because read_write allows it) |
| Releases | `GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=100`, up to 5 pages | `name`, `tag_name`, `draft`, `published_at` | Yes, raw (tested) |
| Commits per day | `GET https://api.github.com/repos/{owner}/{repo}/commits?per_page=100`, up to 10 pages (latest 1,000) | `commit.committer.date` (or `author.date`) | Yes, raw (tested) |
| Repositories to pick from | Native: `GET /installation/repositories`. Composio: `GET /user/repos?affiliation=owner,collaborator,organization_member` | `full_name`, `private`, `default_branch` | Yes |
| PostHog monthly active users | `POST {host}/api/projects/{id}/query/` with a `TrendsQuery`, `math: monthly_active`, `interval: day`, `date_from: -365d` | `results[0].days[]`, `results[0].data[]` | Possible with an API-key connection, but pointless (below) |
| GA4 monthly active users | `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`, dimension `date`, metric `active28DayUsers`, 364 days | `rows[].dimensionValues[0]`, `rows[].metricValues[0]` | Yes, built (tested with a mocked proxy) |

So nothing is missing at the data level. The gaps are all in **who grants what**.

### Stripe through Composio

- **Read-only is impossible.** Composio's Stripe OAuth is a Stripe **Connect** OAuth app (you create it under Settings → Connect). Stripe's OAuth reference says `read_only` "can only be specified for extensions", and Stripe has deprecated Connect extensions: "You can no longer build new Connect extensions. Stripe Apps replaces Connect extensions." A new Connect app therefore gets `read_write`, which means it could create charges, refund, cancel and change things on the founder's account. Composio's alternative is an API key that the founder pastes into Composio's page. That's exactly the friction, and the secret-sharing, we built the Stripe App to avoid. A restricted, read-only key would work, but founders would have to make one by hand.
- **Some founders couldn't connect at all.** Since June 2021, platforms using OAuth with `read_write` can't connect to accounts controlled by another platform.
- **Stripe discourages it.** Stripe's OAuth guide says "OAuth is not recommended for new Connect platforms."
- **Whose name founders see.** With Composio-managed auth, Stripe shows Composio's Connect platform. With our own Connect app inside Composio, it shows ours, but still asks for read and write. Our Stripe App shows "TinyTown", with our purpose text next to each permission (`stripe-app/stripe-app.json`).
- **Our Stripe App's requirements** (`docs/SETUP.md` §3): Stripe reviews it, about 4 business days a round. Until it's published, only 25 external test accounts can install it. Start the review at least 14 days before a paid wave (`docs/LAUNCH.md`).

### GitHub through Composio

Composio's GitHub auth is an OAuth App with scopes such as `repo,read:org`. GitHub's own docs say `repo` "grants full access to public and private repositories including read and write access to code". OAuth Apps have no read-only scope for private repositories. Our GitHub App asks for **Contents: read-only** and **Metadata: read-only**, only on the repositories the founder picks. You could put our GitHub App's client ID and secret into a Composio custom auth config, which would give user-to-server tokens limited by the App's permissions. Composio doesn't document this, so it's unproven.

### PostHog through Composio

Composio's PostHog toolkit uses the same personal API key (`PersonalAPIKeyAuth`). The founder would paste it into Composio's page instead of ours, and Composio would hold it instead of us. There's nothing to gain, so this isn't built.

### Other analytics, for founders without PostHog

| Source | In Composio? | The call that gives monthly actives | Verdict |
|---|---|---|---|
| **Google Analytics 4** | Yes, OAuth2, Composio-managed app available | Data API `runReport`, metric `active28DayUsers` by `date`: for each day, people active in the 28 days up to it. GA4's own definition is "the number of distinct active users … within a 28 day period" | **Built** behind the flag. The copy says "28 days" (PostHog's is 30); both are monthly actives. |
| **Amplitude** | Yes, API key and secret (`AMPLITUDE_GET_ACTIVE_USERS`, `GET /api/2/users?m=active&i=30`; EU host `analytics.eu.amplitude.com`) | `i=30` returns "monthly" counts, but Amplitude's docs don't say whether those are calendar months or a rolling 30 days per day | **Not built.** Check against a real project first. It's a pasted key either way, so it could be native like PostHog. |
| **Mixpanel** | Yes, Basic auth with a service account | No direct monthly-active-users call. `MIXPANEL_QUERY_INSIGHT` can read a saved Insights report (`bookmark_id`) that the founder sets up as "unique users, rolling 30 days". Query API limit: 60 queries an hour per project | **Not built.** It needs a report per founder; doable later with a "paste your report link" step. |
| **Plausible** | Yes, API key (`PLAUSIBLE_ANALYTICS_QUERY_STATS`) | None. Plausible's salt is "rotated and deleted every 24 hours" and "does not let us recognize the same visitor across days", so a 30-day visitor count counts a returning person once per day they visited | **Never.** It would inflate the population, and the world never fakes a number. |

### Cost, limits, speed, and running it from Vercel

- **Pricing** (composio.dev/pricing): Hobby is free (100,000 tool calls a month, then it stops). Pro is $29 a month with 100,000 calls included, then $0.0003 a call. With Composio-managed apps, 20,000 of those are included and then it's $0.0005 a call. Enterprise is custom.
- **Our volume at 10,000 founders** (an estimate): the hourly refresh rebuilds up to 400 founders a run (`server/pipelines/refresh.ts`), up to 9,600 a day, plus visits after the 15-minute cache, so roughly 10,000 to 15,000 rebuilds a day. A typical rebuild is about 2 Stripe pages plus about 6 GitHub pages, so 8 calls. That's 2.4M to 3.6M proxied calls a month: about **$700 to $1,050 a month** on Pro with our own OAuth apps, or **$1,200 to $1,800** with Composio-managed apps. Stripe alone would be about $200 a month. GA4 is one call per rebuild, only for founders who choose it: about $100 a month even if everyone did.
- **Rate limits:** 2,000 requests a minute (Hobby) or 10,000 (Pro), per organisation, shared by every endpoint, with `Retry-After` on 429s. An hourly run of 400 founders is about 3,200 calls spread over a few minutes. A launch-day rush of visits could pass Hobby's limit, so use Pro.
- **Latency:** each request gains a hop (us → Composio → provider). Stripe pages are fetched in sequence (cursor paging), so a 20-page history adds 20 hops inside the same 15-second budget. Not measured yet.
- **Tokens:** Composio stores and refreshes them. Customer-managed keys (KMS) are Enterprise-only. Today we hold one encrypted refresh token per founder (AES-256-GCM under `TOKEN_ENCRYPTION_KEY`, rotatable; `docs/SECURITY.md`).
- **No SDK needed.** Everything is plain `fetch` to `https://backend.composio.dev/api/v3.1` with an `x-api-key` header, so it runs in our Vercel function with no new dependencies.

## What each connector reads (native, the default)

### Stripe: our Stripe App (`stripe-app/stripe-app.json`, `server/stripe-app.ts`)

- **Permissions:** `subscription_read` ("TinyTown reads your subscriptions to rebuild your daily MRR and paying customers…") and `plan_read` ("…reads the prices on your subscriptions to work out monthly recurring revenue").
- **Flow:** `POST /api/connect/stripe` → `https://marketplace.stripe.com/oauth/v2/authorize?client_id&redirect_uri&state` → `GET /api/connect/stripe/callback?code&state` → `POST https://api.stripe.com/v1/oauth/token` (with our app's secret key) → refresh token stored encrypted. Access tokens last an hour and refresh tokens roll on every use (`accessToken()`).
- **Reads:** `GET /v1/subscriptions?status=all&limit=100` and its following pages, nothing else.
- **Never:** customers' names, emails or cards (no `customer_read` or `payment_method_read`), and nothing that writes.
- **Test mode:** refused unless `ALLOW_TEST_MODE=1`. Test data never drives a city.

### GitHub: our GitHub App (`server/github-app.ts`)

- **Permissions:** Contents read-only, Metadata read-only. No webhooks. "Request user authorization (OAuth) during installation" is on, so we can prove the installation belongs to whoever is connecting.
- **Flow:** `POST /api/connect/github` → `https://github.com/apps/{slug}/installations/new?state` → callback with `code` and `installation_id` → `GET /user/installations` with the user's token, to check the installation is theirs → stored. Installation tokens come from `POST /app/installations/{id}/access_tokens` (an hour; cached).
- **Reads:** `GET /installation/repositories` (to pick one), `GET /repos/{repo}` (the access check), `GET /repos/{repo}/commits`, `GET /repos/{repo}/releases`.
- **Never:** repositories the founder didn't share, and any write. It never downloads code; it reads only the commit and release lists.

### PostHog (`server/users.ts`, `server/posthog.ts`)

- **Key:** a personal API key (`phx_…`) with the **Query: Read** scope, sent once to our server, checked, then stored AES-256-GCM encrypted and never shown again.
- **Hosts:** PostHog Cloud (`us.posthog.com`, `eu.posthog.com`; `us.i.`/`eu.i.`/`app.` are mapped to these). Self-hosted only if it's listed in `POSTHOG_HOSTS`.
- **Reads:** one `TrendsQuery` (`math: monthly_active`, daily, 365 days): a count per day and nothing else.
- **Test connection:** `PUT /api/connect/users` with `test: true` runs the same query and returns `{ ok, source, monthlyActiveUsers, asOf, days }` **without saving** (new in this change).

### Paying customers and a number you set

- **Paying customers** (the default): the population is Stripe's paying customers. Nothing more to read.
- **A number you set:** `PUT /api/connect/users { source: 'manual', value }`. Each entry counts from the day it's made (earlier days keep what was true then), and up to 400 entries are kept. It can be updated in place from Account → Connections.

## Composio, as built (`server/composio.ts`)

Off by default. When it's on, the screens say exactly what Composio's access allows: Stripe and GitHub show **Read and write**, and the grant is named.

| Env var | Meaning |
|---|---|
| `CONNECT_VIA=composio` | Turns the Composio path on. Anything else, or unset, means native. |
| `COMPOSIO_API_KEY` | The project's API key (secret, server only). |
| `COMPOSIO_STRIPE_AUTH_CONFIG` | `ac_…` for the Stripe toolkit. Without it, Stripe stays native. |
| `COMPOSIO_GITHUB_AUTH_CONFIG` | `ac_…` for the GitHub toolkit. Without it, GitHub stays native. |
| `COMPOSIO_GA4_AUTH_CONFIG` | `ac_…` for the Google Analytics toolkit. Turns on the GA4 option. |
| `COMPOSIO_API_URL` | Optional; defaults to `https://backend.composio.dev/api/v3.1`. |

**The flow** keeps our own security model:

1. `POST /api/connect/{provider}` returns our own callback URL with a signed `state`, `via=composio`, and the HttpOnly nonce cookie.
2. The browser goes there. The callback checks the state and cookie, asks Composio for a link (`POST /connected_accounts/link` with `user_id` set to our user id and `callback_url` set to our callback with the same state), and redirects out.
3. Composio sends the founder back with `status=success&connected_account_id=ca_…`. The callback checks the state and cookie again, then **verifies the account belongs to this user, for this toolkit, and is ACTIVE** (`GET /connected_accounts?connected_account_ids&user_ids&toolkit_slugs`), and stores it as `metadata: { via: 'composio', composio: 'ca_…' }` with no secret.
4. Reads go through the proxy. A provider 401 or 403, or Composio saying the account is gone, means "reconnect" (409 `not_connected`), the same as native.

Rows: a Stripe row keeps `account_id = acct_…`. A GitHub row keeps `account_id = composio:ca_…`, deliberately not a number, so account deletion never mistakes it for an installation id. Tests: `tests/server-connect-composio.test.ts`.

**Turning Composio on, for GA4 only** (the recommended use):

1. Create a Composio project, then a Google Analytics auth config. Composio-managed is fine to start; Google's consent will name Composio. **Set the auth config's scopes to `https://www.googleapis.com/auth/analytics.readonly` only** (Composio lets you override a toolkit's default scopes). The card says "Read-only" and names that scope, so it has to be true. Add `COMPOSIO_API_KEY`, `COMPOSIO_GA4_AUTH_CONFIG` and `CONNECT_VIA=composio` in Vercel. Leave the Stripe and GitHub auth configs unset, so those stay native.
2. Apply migration `0008` and the wiring patches in the lead's report: routes `POST /api/connect/ga4`, `GET /api/connect/ga4/callback`, `GET /api/connect/ga4/properties`; `ga4` in the provider and users-source types; `?connected=ga4` in `boot.ts`; and `OnboardingDeps.ga4` in `hosted.ts`. Until they're applied, the option stays hidden.

## What the screens show when something fails

Every failure the server can return has a sentence (the server's own) and one action that fixes it.

| Where | Server says | Card shows |
|---|---|---|
| Stripe callback | `connect_error=stripe:denied` | "You cancelled on Stripe, so nothing was connected." + **Try again** |
| | `state` (expired, or from another browser) | "That connection link expired. Start again from here." + **Try again** |
| | `testmode` | "That's a test-mode Stripe account…" + **Try again** (install in live mode) |
| | `upstream` / `invalid_request` / `not_configured` | The server's sentence + **Try again** |
| Stripe token refresh, or the timeline | 409 `not_connected` "Your Stripe connection has expired. Connect Stripe again." | Card turns **Needs reconnecting** (setup and account) + **Reconnect on Stripe**; "Your city and everything you built are safe." |
| Stripe numbers | 502 "Stripe took too long to respond…" | The card's "what it found" strip shows the sentence + **Read them again** |
| GitHub callback | `denied`, `state`, `installation` ("belongs to a different account"), `not_installed`, `pending_approval` ("Your organisation owner needs to approve…"), `upstream` | The sentence + **Try again** |
| GitHub repositories | 409 "The TinyTown GitHub App was uninstalled. Connect GitHub again." | Card turns **Needs reconnecting** + **Install on GitHub** |
| | 502 "GitHub responded N listing repositories." | The sentence + **Try again** (and "Write to us" when there's a support address) |
| | An empty list | "The app can't see any repositories yet…" + **Choose repositories on GitHub** |
| Picking a repository | 400 "TinyTown can't see that repository. Add it to the app's access on GitHub." | The sentence + **Share more on GitHub** |
| PostHog, inline as you type | (no server) a `phc_` key, a non-numeric project id, a non-https host | Next to the field: "That's a project key (phc_), which can only send events. Use a personal API key (phx_)." and similar |
| PostHog test or save | 400 address / project id / key format; 409 "PostHog didn't accept the API key…"; 409 "PostHog couldn't find that project id." | Placed next to the field it's about |
| | 502 "PostHog responded N." | Under the form + **Try again** |
| Any call | 429 `rate_limited` | The sentence, no button (waiting is the fix) |
| Connecting isn't configured | 503 `not_configured` | "Connecting Stripe isn't set up on this server yet." |

The mock API has every one of these: `?mockapi=stripe-broken|stripe-test|github-gone|manual|composio`, plus `&mockerr=posthog-key|posthog-project|repo|preview|connect|repos`, plus `&mockempty` for a Stripe account with no subscriptions yet (`src/api/mock.ts`).

## Sources

- Composio: [tool proxy](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteProxy), [connect links](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink), [connected accounts](https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccounts), [white-labelling](https://docs.composio.dev/docs/auth-configuration/white-labeling), [rate limits](https://docs.composio.dev/reference/rate-limits), [pricing](https://composio.dev/pricing), toolkits: [Stripe](https://docs.composio.dev/toolkits/stripe), [GitHub](https://composio.dev/auth/github), [PostHog](https://docs.composio.dev/toolkits/posthog), [Google Analytics](https://docs.composio.dev/toolkits/google_analytics), [Mixpanel](https://docs.composio.dev/toolkits/mixpanel), [Amplitude](https://docs.composio.dev/toolkits/amplitude), [Plausible](https://docs.composio.dev/toolkits/plausible_analytics), [Stripe auth setup](https://composio.dev/auth/stripe)
- Stripe: [Connect OAuth reference](https://docs.stripe.com/connect/oauth-reference), [legacy Connect extensions](https://docs.stripe.com/building-extensions), [Stripe Apps permissions](https://docs.stripe.com/stripe-apps/reference/permissions), [OAuth for Stripe Apps](https://docs.stripe.com/stripe-apps/api-authentication/oauth)
- GitHub: [OAuth App scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- Google: [GA4 Data API schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
- Amplitude: [Dashboard REST API](https://amplitude.com/docs/apis/analytics/dashboard-rest) · Plausible: [data policy](https://plausible.io/data-policy) · PostHog: [query API](https://posthog.com/docs/api/queries)
