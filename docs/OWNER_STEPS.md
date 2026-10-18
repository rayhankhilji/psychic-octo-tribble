# Your steps to launch TinyTown

Plain, in order. Each step says what to click, what to copy, and where to put it. Claude does everything else (the database, Stripe's prices, Vercel's settings, deploying, testing).

**The one rule:** never paste a key, token or password into the chat. Keys go in the cloud environment's secrets (Part 1, step 4). Names and IDs that aren't secret are fine to paste.

---

## Part 1: today (about 20 minutes)

### 1. Supabase (the database and sign-in)

1. Go to **supabase.com** and sign up (or sign in).
2. Click **New project**.
   - Name: `tinytown`
   - Database password: click **Generate**, then save it in your password manager.
   - Region: **East US (North Virginia)** (closest to Vercel's default).
   - Plan: Free is fine while we test. Switch to **Pro ($25/month)** before launch, or the project pauses after a quiet week.
3. When it's ready, copy the **project reference**: the short code in the address bar after `/project/` (it looks like `abcdefghijklmnopqrst`). **This one is fine to paste in the chat.**
4. Make a token: click your avatar (bottom left) → **Account preferences** → **Access Tokens** → **Generate new token**. Name it `claude`. Copy it. **Don't paste it in the chat**: it goes in step 4.

### 2. Stripe (payments)

1. Go to **dashboard.stripe.com** and sign up (or sign in).
2. Make sure **Test mode** is on (the toggle at the top right says "Test mode").
3. Click **Developers** (bottom left) → **API keys**.
4. Next to **Secret key**, click **Reveal test key** and copy it. It starts with `sk_test_`. **Don't paste it in the chat.**

You don't need to create any products or prices: Claude does that.

### 3. Vercel (the website)

1. Go to **vercel.com** and sign up with **Continue with GitHub** (use the GitHub account that owns the TinyTown repository).
2. Choose the **Pro** plan ($20/month). The free plan isn't allowed for paid products.
3. Click **Add New…** → **Project** → find **psychic-octo-tribble** → **Import**. Leave every setting as it is and click **Deploy**. It's fine if this first deploy says the site isn't set up yet.
4. Note the **project name** and your **team name** (shown top left). **Fine to paste in the chat.**
5. Make a token: click your avatar (top right) → **Account Settings** → **Tokens** → **Create**. Name: `claude`. Scope: your team. Expiration: 30 days. Copy it. **Don't paste it in the chat.**

### 4. Put the keys where Claude can use them

1. In this Claude Code session, click the **environment name** in the title bar at the top, then **Edit**.
2. Find **Network secrets** (in some app versions it's called **Environment variables**).
3. Add these three, each name exactly as written:

   | Name | Value |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | the Supabase token from step 1.4 |
   | `STRIPE_SECRET_KEY` | the `sk_test_…` key from step 2.4 |
   | `VERCEL_TOKEN` | the Vercel token from step 3.5 |

4. Save.

### 5. Tell Claude

Start a **new session** on this repository (new sessions are what pick up the keys) and send:

> Keys are in. Supabase project ref: `…`. Vercel project: `…`, team: `…`. Run the launch setup in test mode.

Claude then:
- runs the database migrations and sets up sign-in and the emails;
- creates the $29-a-year price, the $9-first-year coupon, the webhook and the billing portal in Stripe (test mode);
- sets every setting in Vercel, including the internal secrets it generates itself;
- deploys a preview and tests sign-up → setup → paywall → $9 offer → payment with a test card.

You'll get a link to try it yourself. The test card is `4242 4242 4242 4242`, any future date, any 3 digits.

---

## Part 2: this week (things only you can do in your accounts)

### 6. The GitHub App (lets founders connect their releases and commits)

1. On GitHub: your avatar → **Settings** → **Developer settings** (bottom of the left menu) → **GitHub Apps** → **New GitHub App**.
2. Fill in:
   - **GitHub App name:** `TinyTown` (if it's taken, `TinyTown City`)
   - **Homepage URL:** your site's address (for now the Vercel one, like `https://tinytown.vercel.app`)
   - **Callback URL:** the same address plus `/api/connect/github/callback`
   - Tick **Request user authorization (OAuth) during installation**
   - **Webhook:** untick **Active**
   - **Permissions → Repository permissions:** **Contents: Read-only** and **Metadata: Read-only**. Leave everything else as "No access".
   - **Where can this GitHub App be installed?** **Any account**
3. Click **Create GitHub App**. On the page that opens:
   - **Generate a new client secret**, and copy it.
   - Scroll down and **Generate a private key**. A `.pem` file downloads.
4. Add these to the environment's **Network secrets** (as in step 4):

   | Name | Where it is |
   |---|---|
   | `GITHUB_APP_ID` | "App ID" at the top of the app's page |
   | `GITHUB_APP_CLIENT_ID` | "Client ID" on the same page |
   | `GITHUB_APP_CLIENT_SECRET` | the client secret you generated |
   | `GITHUB_APP_SLUG` | the last part of the app's public link, `github.com/apps/<this>` |
   | `GITHUB_APP_PRIVATE_KEY` | open the `.pem` file in a text editor and paste the whole thing, including the `BEGIN` and `END` lines |

5. Delete the `.pem` file from your Downloads.

### 7. The Stripe App (lets founders connect their Stripe, read-only)

This needs Stripe's review (about 4 working days each round), so start it early. Until it's approved, only 25 test accounts can connect, so no paid wave before then.

1. Tell Claude your final address (domain or Vercel address). Claude fills in the app's settings file (`stripe-app/stripe-app.json`) and tries to upload it.
2. If Claude can't upload it from the cloud, do it on your computer:
   1. Install the Stripe CLI: **docs.stripe.com/stripe-cli**.
   2. In a terminal: `stripe login`, then `stripe plugin install apps`.
   3. In the project's `stripe-app` folder: `stripe apps upload`.
3. In Stripe: **Developers** → **Apps** → **TinyTown** → **Settings**. Copy the **client ID** (`ca_…`) and add it to Network secrets as `STRIPE_APP_CLIENT_ID`.
4. On the app's page, click **Submit for review**. For "install URL", give your site's address.

### 8. Email (so sign-in links and receipts arrive)

1. Go to **resend.com** and sign up.
2. Choose the **Pro plan** ($20/month).
3. **Domains** → **Add domain**: use a subdomain of your domain, like `mail.yourdomain.com`.
4. Resend shows some DNS records. Add them where you bought your domain (Claude can walk you through your registrar).
5. **API Keys** → **Create**, then add it to Network secrets as `RESEND_API_KEY`.

### 9. The domain (when you're ready to buy one)

1. Buy it from any registrar (Cloudflare, Namecheap, Porkbun).
2. In Vercel: your project → **Settings** → **Domains** → **Add** → type the domain.
3. Vercel shows one or two DNS records. Add them at the registrar.
4. Tell Claude the domain: it updates Stripe, Supabase and the GitHub App's addresses for you, except the GitHub App's two URLs, which you change yourself on its page.

---

## Part 3: going live

### 10. Stripe live mode

1. In Stripe, turn **Test mode** off and complete **Activate payments**: business details, identity and a bank account.
2. **Developers** → **API keys**, then copy the **live** secret key (`sk_live_…`).
3. Add it to Network secrets as `STRIPE_LIVE_SECRET_KEY`.
4. Tell Claude "go live". It creates the live price, coupon, webhook and portal, switches Vercel to them, and pushes to `main`.

### 11. Before the waitlist

1. **A lawyer** checks the four pages in `public/legal/` (terms, privacy, refunds, contact) and fills the bracketed gaps: your company name, address, governing law, and the EU/UK 14-day cancellation right against "no refunds".
2. **Supabase Pro** on (step 1.2).
3. **Your waitlist list** as a CSV with an `email` column. Give it to Claude, who imports it.
4. Invite in waves from `/admin.html`: about 25 friends first, then 500, then the rest.

---

## What it costs

- Stripe: about $1.34 of each $29 sale and $0.62 of each $9 sale.
- Monthly: Vercel $20, Supabase $25, Resend $20, plus a domain (~$1). Budget $15–60 more for the database during launch week.
- Servers per founder: about a cent or two a month.
