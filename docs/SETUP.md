# Setting up hosted TinyTown

This is the checklist for putting TinyTown online as the paid product: accounts, billing, the paywall and founders' real data. Work through it top to bottom; each section ends with the values it produces, and the table at the end says where every one of them goes.

How it fits together is in `docs/INFRA.md`. You don't need to read it to follow this.

> **Never paste a secret key into a chat, an issue, a commit or a screenshot.** Secret values go in exactly two places: Vercel's environment variable settings (for the live site) and a local `.env` file on your own machine (for development, already git-ignored). If one leaks, roll it in the provider's dashboard and update Vercel.

## What you need to decide or pay for first

- **The domain.** Everything below needs the final address (Stripe, GitHub and Supabase all store it). You can start on the free `your-project.vercel.app` address and add a domain later, but then you redo the "URLs to paste" steps. Nothing is bought without your say-so.
- **Vercel plan.** Vercel's free Hobby plan is for non-commercial use only, so a paid product needs **Vercel Pro** (about $20 a month per member).
- **Supabase plan.** The free plan pauses a project after a week with no traffic, which would take the city offline. Start on free while testing; move to **Pro** (about $25 a month) before you launch.
- **Stripe.** No monthly fee; Stripe takes its usual cut of each payment (and Stripe Billing's fee on subscriptions). You need an activated Stripe account to take live payments.
- **Google sign-in** needs a Google Cloud project with an OAuth consent screen. It's free, but Google may ask to verify the app before showing your logo.
- **The Stripe App** is reviewed by Stripe before founders outside your test accounts can install it. Plan a few days for review.
- **Still open from the design:** a 14-day money-back guarantee (recommended). It needs no code: it's a refund you issue from the Stripe Dashboard and a line on the pricing card.

## 0. Make your two secrets

TinyTown needs two random secrets of its own. In a terminal, run this twice and keep the two outputs:

```bash
openssl rand -base64 32
```

- The first is `TOKEN_ENCRYPTION_KEY`. It encrypts founders' Stripe and PostHog credentials in the database. **Don't change it later**: every founder would have to reconnect.
- The second is `STATE_SECRET`. It signs the links that connect Stripe and GitHub.

## 1. Supabase (accounts and saves)

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**. Pick a region near most of your founders (or near Vercel's default, Washington DC, `us-east-1`). Save the database password in your password manager; TinyTown doesn't need it.
2. **Run the migration.** In the project: **SQL Editor** → **New query** → paste the whole of `supabase/migrations/0001_init.sql` → **Run**. You should see "Success. No rows returned". (If you use the Supabase CLI instead: `supabase link` then `supabase db push`.)
   - This creates `profiles`, `subscriptions`, `connections`, `worlds` and `timelines`, all with row-level security on and no policies: the browser can't read them; only the server can.
3. **Keys.** **Project Settings** → **Data API** for the **Project URL**, and **Project Settings** → **API Keys** for:
   - the **publishable** key (or the legacy **anon** key): public, the browser uses it to sign in;
   - the **secret** key (or the legacy **service_role** key): **secret**, full access to the database. Server only.
4. **URLs.** **Authentication** → **URL Configuration**:
   - **Site URL:** `https://YOUR-DOMAIN`
   - **Redirect URLs:** add `https://YOUR-DOMAIN/**` and, for development, `http://localhost:5173/**`
5. **Sign-in methods.** **Authentication** → **Sign In / Providers**:
   - **Email:** on by default. Magic links work out of the box with Supabase's built-in mailer, which is rate-limited (a few emails an hour). Before launch, set up custom SMTP under **Authentication** → **Emails** (Resend, Postmark or similar) so sign-in emails always arrive.
   - **Google:** in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an **OAuth client ID** (type: Web application). Authorised redirect URI: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback` (Supabase shows this exact URL on the Google provider page). Paste the client ID and secret into Supabase's Google provider and enable it.
   - **GitHub (sign-in):** on GitHub, **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**. Homepage: `https://YOUR-DOMAIN`. Authorization callback URL: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`. Paste its client ID and a client secret into Supabase's GitHub provider. (This is only for signing in. Reading a founder's releases uses the separate GitHub App in section 4.)

**You now have:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Stripe: getting paid

Do this in **test mode** first (the toggle in the Dashboard), check the whole flow, then repeat it in live mode and swap the keys in Vercel.

1. **The product.** [Product catalogue](https://dashboard.stripe.com/products) → **Add product**:
   - Name: `TinyTown`. Description: something like "Your startup, as a living city".
   - Add a **recurring** price: **$12.00 USD, monthly**.
   - Add a second **recurring** price on the same product: **$99.00 USD, yearly**.
   - No free trial on either. Open each price and copy its id (`price_…`).
2. **API key.** [Developers → API keys](https://dashboard.stripe.com/apikeys): copy the **Secret key** (`sk_test_…` now, `sk_live_…` later). The simplest setup uses it for both `STRIPE_BILLING_SECRET_KEY` and the Stripe App (section 3). If you'd rather use a restricted key for billing, give it write access to Customers, Checkout Sessions and Customer portal, and read access to Subscriptions and Prices; the Stripe App still needs the full secret key.
3. **Webhook.** [Developers → Webhooks](https://dashboard.stripe.com/webhooks) → **Add endpoint** (or **Add destination** → Webhook endpoint):
   - Endpoint URL: `https://YOUR-DOMAIN/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Open the endpoint and reveal its **Signing secret** (`whsec_…`).
4. **Customer portal** (where founders change plan, update their card, cancel and get invoices): [Settings → Billing → Customer portal](https://dashboard.stripe.com/settings/billing/portal):
   - Turn on: update payment method, view invoice history, cancel subscriptions (at the end of the period).
   - **Switch plans:** allow switching, and add the TinyTown product with both prices so people can move between monthly and yearly.
   - Fill in your business name, privacy policy and terms links.
5. **Branding:** [Settings → Branding](https://dashboard.stripe.com/settings/branding): logo, icon and colours (Checkout and the portal use them).

**You now have:** `STRIPE_BILLING_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`.

## 3. The Stripe App (founders connect their Stripe)

Founders never paste keys. They install the TinyTown Stripe App, which asks for **read-only** access to subscriptions and prices; Stripe sends them back to TinyTown and we keep an encrypted refresh token. The app lives in `stripe-app/`.

1. **Install the Stripe CLI** ([docs.stripe.com/stripe-cli](https://docs.stripe.com/stripe-cli)) and its apps plugin, then log in:
   ```bash
   stripe login
   stripe plugin install apps
   ```
2. **Fill in the manifest.** In `stripe-app/stripe-app.json`, replace `YOUR-TINYTOWN-DOMAIN` (twice) with your domain. The redirect URI must be exactly `https://YOUR-DOMAIN/api/connect/stripe/callback`. For local testing you can add `http://localhost:5173/api/connect/stripe/callback` as a second entry (test mode only; live mode requires HTTPS).
3. **Upload it.** From the `stripe-app/` folder run `stripe apps upload`. If the CLI says the folder isn't an app project, run `stripe apps create tinytown` somewhere else, copy our `stripe-app.json` and `icon.png` over the generated ones, and upload from there. The `id` (`com.tinytown.city`) must be unique on Stripe: change it if Stripe says it's taken.
4. **Client ID.** Open the app in the Dashboard (the CLI prints a link; otherwise **Developers** → **Apps** → your app). Copy its **client ID** (`ca_…`) from the **Settings** tab.
5. **Test it.** On the app's **External test** tab → **Get started**, then copy the authorize link from **Test OAuth**. While testing, set `STRIPE_APP_INSTALL_URL` to that link's address *without* its query string (everything before `?`), use your **test** secret key as `STRIPE_APP_SECRET_KEY`, and set `ALLOW_TEST_MODE=1` so test data can drive a city. Then sign in to TinyTown, pay with a [test card](https://docs.stripe.com/testing) (`4242 4242 4242 4242`) and press **Connect Stripe**.
6. **Publish.** When it works, submit the app for review from its page ([Stripe's guide](https://docs.stripe.com/stripe-apps/publish-app)). Stripe asks for an install URL: give `https://YOUR-DOMAIN/` (signed-in founders get the Connect Stripe button there). Once it's approved, remove `STRIPE_APP_INSTALL_URL` and `ALLOW_TEST_MODE`, and use your **live** secret key.

**You now have:** `STRIPE_APP_CLIENT_ID`, `STRIPE_APP_SECRET_KEY` (optional when it's the same as the billing key), and for testing only `STRIPE_APP_INSTALL_URL` and `ALLOW_TEST_MODE`.

## 4. GitHub App (releases and commits)

1. On GitHub: **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App** (or under your organisation's settings, if TinyTown should own it).
   - **GitHub App name:** `TinyTown` (or `TinyTown City` if taken). Its URL name is the **slug**: `github.com/apps/<slug>`.
   - **Homepage URL:** `https://YOUR-DOMAIN`
   - **Callback URL:** `https://YOUR-DOMAIN/api/connect/github/callback`
   - Tick **Request user authorization (OAuth) during installation**. (This is how TinyTown checks that the installation really belongs to the founder connecting it. It also greys out the Setup URL, which is expected.)
   - **Webhook:** untick **Active**. TinyTown doesn't use GitHub webhooks.
   - **Repository permissions:** **Contents: Read-only**, **Metadata: Read-only**. Nothing else.
   - **Where can this GitHub App be installed?** **Any account**.
2. **Create GitHub App**, then on its settings page:
   - copy the **App ID** and the **Client ID**;
   - **Generate a new client secret** and copy it;
   - **Generate a private key**: a `.pem` file downloads. Turn it into one line for Vercel: `base64 -w0 your-key.pem` (Linux) or `base64 -i your-key.pem | tr -d '\n'` (macOS). Delete the downloaded file once it's stored.

**You now have:** `GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`.

## 5. PostHog (optional, nothing to set up)

Founders who use PostHog can make it the source of their population (monthly active users). They paste their own **personal API key** in TinyTown; it's stored encrypted and only the server uses it. In PostHog they create it under **Settings** → **Personal API keys** with the **Query: Read** scope for their project. TinyTown accepts PostHog Cloud (`us.posthog.com`, `eu.posthog.com`). If you ever want to allow a self-hosted PostHog, list its host in `POSTHOG_HOSTS`.

## 6. Vercel (the live site)

1. [vercel.com/new](https://vercel.com/new) → import the GitHub repository. Leave the build settings alone: `vercel.json` in the repo sets them (framework "Other", build `npm run build && node server/build-vercel.mjs`).
2. **Settings** → **Git** → **Production Branch:** `main`.
3. **Settings** → **Environment Variables:** add every variable from the table below for **Production** (and **Preview**, with test-mode Stripe keys, if you want preview deploys to work). Mark the secret ones **Sensitive**.
4. **Deploy.** Then check it:
   - `https://YOUR-DOMAIN/api/config` should show `"hosted": true`, your two plans, and `"connect": {"stripe": true, "github": true, "posthog": true}`. It must not contain any secret.
   - In the deployment's **Functions** tab there is one function, `/api`.
   - Sign in, pay with a test card, connect Stripe and GitHub, and buy something in the city.
5. If you add a domain later: **Settings** → **Domains**, then update `APP_URL`, the Supabase Site URL and redirect URLs, the Stripe webhook URL, the Stripe App's `allowed_redirect_uris` (and upload again), and the GitHub App's homepage and callback URLs.

## Every environment variable

Public values can be seen by anyone; secret ones must only ever live in Vercel and your local `.env`.

| Variable | Where it comes from | Public or secret |
|---|---|---|
| `APP_URL` | Your site's address, e.g. `https://tinytown.app` (no trailing slash). On Vercel it falls back to the production domain | Public |
| `SUPABASE_URL` | Supabase → Project Settings → Data API → Project URL | Public |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → publishable (or legacy anon) | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → secret (or legacy service_role) | **Secret** |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` (section 0). Never change it once founders have connected | **Secret** |
| `STATE_SECRET` | `openssl rand -base64 32` (section 0) | **Secret** |
| `STRIPE_BILLING_SECRET_KEY` | Stripe → Developers → API keys → Secret key | **Secret** |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → your endpoint → Signing secret | **Secret** |
| `STRIPE_PRICE_MONTHLY` | Stripe → Product catalogue → TinyTown → the $12 monthly price id | Public |
| `STRIPE_PRICE_YEARLY` | Stripe → Product catalogue → TinyTown → the $99 yearly price id | Public |
| `STRIPE_APP_CLIENT_ID` | Stripe → your app → Settings → client ID (`ca_…`) | Public |
| `STRIPE_APP_SECRET_KEY` | The full secret key of the account that owns the app. Optional: defaults to `STRIPE_BILLING_SECRET_KEY` | **Secret** |
| `STRIPE_APP_INSTALL_URL` | Testing only: the External test authorize link, without its query string | Public |
| `ALLOW_TEST_MODE` | Testing only: `1` lets test-mode Stripe data drive a city. Leave unset in production | Public |
| `GITHUB_APP_SLUG` | The `<slug>` in `github.com/apps/<slug>` | Public |
| `GITHUB_APP_ID` | GitHub App settings → App ID | Public |
| `GITHUB_APP_CLIENT_ID` | GitHub App settings → Client ID | Public |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App settings → Generate a new client secret | **Secret** |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App settings → Generate a private key, base64 on one line | **Secret** |
| `POSTHOG_HOSTS` | Optional. Defaults to `us.posthog.com,eu.posthog.com` | Public |
| `TINYTOWN_NAME`, `STRIPE_SECRET_KEY`, `GITHUB_REPO`, `GITHUB_TOKEN`, `PORT` | Local mode only (your own data with no accounts); ignored once Supabase is set | Mixed |

Each feature switches on only when all of its variables are set, and `/api/config` tells the app what's available. Without the Supabase three, TinyTown runs exactly as it did before: the demo, or your `.env` data.

## Running it on your machine

**Without accounts (as before):** `npm run dev` and open `http://localhost:5173/?demo`. For your own numbers, put `STRIPE_SECRET_KEY` or `GITHUB_REPO` in `.env` and also run `npm run dev:server`.

**With accounts (hosted mode, test keys):**

1. Copy `.env.example` to `.env` and fill in the hosted sections with **test-mode** Stripe values, `APP_URL=http://localhost:5173` and `ALLOW_TEST_MODE=1`.
2. In two terminals: `npm run dev:server` (the API on :8787) and `npm run dev` (the app on :5173, which forwards `/api` to the API).
3. Forward Stripe's webhooks to your machine and use the secret it prints as `STRIPE_WEBHOOK_SECRET`:
   ```bash
   stripe listen --forward-to localhost:8787/api/billing/webhook
   ```
4. For GitHub, the App's callback URL must point at your machine while you test (`http://localhost:5173/api/connect/github/callback`), or use a second GitHub App for development.

**Check the Vercel build without deploying:** `npm run build && node server/build-vercel.mjs`. It writes `.vercel/output/` (the static site, one function and its routes) and loads the function once as a smoke test; it should end with "function smoke test passed". With the Vercel CLI you can also run `npx vercel build` and `npx vercel deploy --prebuilt` to a preview.
