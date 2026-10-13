# Sign-in emails

Supabase Auth sends the sign-in emails itself (magic links, sign-up confirmations and the rest). These HTML files are those emails in the TinyTown look. They are generated from `server/email/auth-templates.ts`; edit that file, then run:

```bash
UPDATE_EMAIL_TEMPLATES=1 npx vitest run tests/server-email-templates.test.ts
```

The test fails whenever a file here drifts from its source.

Everything below happens in the Supabase dashboard and the Resend dashboard. Do it **before** the first invite goes out: Supabase's built-in mailer sends **2 emails an hour**, only to your own team's addresses, and can't serve a launch.

## 1. Resend: a sending domain

1. Create a Resend account and pick the **Pro** plan ($20 a month for 50,000 emails; see "Costs" below). The free plan stops at 100 emails a day.
2. **Domains → Add domain.** Use a subdomain of your real domain, such as `mail.yourdomain.com`, so sending reputation stays off your root domain. Choose the region closest to your users (`us-east-1` is fine).
3. Add the DNS records Resend shows, exactly as shown. For `mail.yourdomain.com` they look like this:

   | Type | Name | Value | Notes |
   |---|---|---|---|
   | MX | `send.mail` | `feedback-smtp.us-east-1.amazonses.com` | priority 10; bounces come back here |
   | TXT | `send.mail` | `v=spf1 include:amazonses.com ~all` | SPF |
   | TXT | `resend._domainkey.mail` | `p=MIGfMA0…` (copy it from Resend) | DKIM |
   | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com;` | DMARC, on the root domain |

   Start DMARC at `p=none`. After a couple of weeks of reports showing `dmarc=pass`, move to `p=quarantine`, then `p=reject`. Gmail and Yahoo require SPF, DKIM and DMARC from anyone sending more than 5,000 emails a day to them.
4. Wait for Resend to show the domain as **Verified** (minutes to an hour).
5. On the domain, leave **click tracking** and **open tracking off**. Click tracking rewrites links, which breaks sign-in links and hurts deliverability.
6. **API Keys → Create API key** with **Sending access** for this domain only. It goes in two places: Vercel as `RESEND_API_KEY` (for TinyTown's own emails) and Supabase's SMTP password (below). You can make two keys so each can be revoked alone.

## 2. Supabase: custom SMTP through Resend

**Authentication → Emails → SMTP Settings → Enable custom SMTP**:

| Field | Value |
|---|---|
| Sender email | `hello@mail.yourdomain.com` (any address on the verified domain) |
| Sender name | `TinyTown` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the Resend API key |
| Minimum interval between emails | `60` seconds (per user; stops one person getting a pile of links) |

Save. Then send yourself a magic link and check it arrives, from TinyTown, not in spam.

## 3. Supabase: rate limits for a 10,000-person launch

Once custom SMTP is on, Supabase starts the email limit at **30 an hour** for the whole project. That would stall the launch within minutes. **Authentication → Rate Limits**:

| Setting | Default | Launch value | Why |
|---|---|---|---|
| Rate limit for sending emails (per hour, whole project) | 30 | **2,000** | Each waitlist wave sends one invite per person from TinyTown, then one sign-in email each when they sign up, plus re-sends. A wave of 2,000 people mostly signs in within the first hour or two. Resend's 10 requests a second (36,000 an hour) is the ceiling. Drop it to 500 after launch week. |
| Sign-ups and sign-ins (per 5 minutes, per IP) | 30 | **60** | Offices, coworking spaces and phone networks put many people behind one IP. Turnstile still stops scripts. |
| Token verifications (per 5 minutes, per IP) | 30 | **60** | Same reason: these are people clicking their links. |
| Token refreshes (per 5 minutes, per IP) | 150 | 150 | Fine as is. |

Also check **Authentication → Providers → Email**: keep **Email OTP Expiration** at `3600` seconds (the emails say links expire in an hour), and leave **Confirm email** on.

And **Authentication → URL Configuration → Site URL** must be the app's address with no trailing slash (the same value as `APP_URL`): the emails load the logo from `{{ .SiteURL }}/apple-touch-icon.png`.

Release waves in steps (for example 500, then 1,000, then 2,000 at a time) and watch Resend's **Logs** for bounces and 429s between them.

## 4. Paste in the templates

**Authentication → Emails → Templates.** For each template, paste the subject into **Subject** and the whole file into **Message body (source)**, then **Save**:

| Template | Subject | File |
|---|---|---|
| Confirm signup | `Confirm your email for TinyTown` | `confirmation.html` |
| Invite user | `You’re invited to TinyTown` | `invite.html` |
| Magic link | `Your TinyTown sign-in link` | `magic_link.html` |
| Change email address | `Confirm your new TinyTown email` | `email_change.html` |
| Reset password | `Sign in to TinyTown` | `recovery.html` |
| Reauthentication | `Your TinyTown verification code` | `reauthentication.html` |

New people who sign in with an email address get **Confirm signup** first; returning people get **Magic link**. TinyTown has no passwords, but someone can still ask for a reset, so **Reset password** simply signs them in.

The templates use Supabase's variables: `{{ .ConfirmationURL }}` (the sign-in link), `{{ .Email }}`, `{{ .NewEmail }}` (change email only), `{{ .Token }}` (the six-digit code, reauthentication only) and `{{ .SiteURL }}`.

For local development with the Supabase CLI, the same files go in `supabase/config.toml`:

```toml
[auth.email.template.magic_link]
subject = "Your TinyTown sign-in link"
content_path = "./supabase/templates/magic_link.html"

[auth.email.template.confirmation]
subject = "Confirm your email for TinyTown"
content_path = "./supabase/templates/confirmation.html"

[auth.email.template.invite]
subject = "You’re invited to TinyTown"
content_path = "./supabase/templates/invite.html"

[auth.email.template.email_change]
subject = "Confirm your new TinyTown email"
content_path = "./supabase/templates/email_change.html"

[auth.email.template.recovery]
subject = "Sign in to TinyTown"
content_path = "./supabase/templates/recovery.html"

[auth.email.template.reauthentication]
subject = "Your TinyTown verification code"
content_path = "./supabase/templates/reauthentication.html"
```

## 5. TinyTown's own emails

The server sends the welcome, payment, plan, connection, account and waitlist emails and the Monday digest through Resend's API. Set in Vercel:

| Variable | Example | Secret? |
|---|---|---|
| `RESEND_API_KEY` | `re_…` | secret |
| `EMAIL_FROM` | `TinyTown <hello@mail.yourdomain.com>` | public |
| `EMAIL_REPLY_TO` | `you@yourdomain.com` (a mailbox a person reads) | public |
| `EMAIL_POSTAL_ADDRESS` | your business postal address; the law (CAN-SPAM) wants it in the digest | public |
| `STRIPE_PORTAL_LOGIN_URL` | optional: `https://billing.stripe.com/p/login/…` from Stripe → Settings → Billing → Customer portal | public |

Without `RESEND_API_KEY` and `EMAIL_FROM` nothing is sent: the server logs "would send" with the kind of email and the user id, and carries on. `STATE_SECRET` (already set for connections) signs the unsubscribe links; without it the digest isn't sent.

## Costs

Resend bills by emails a month. At launch, roughly: 10,000 waitlist invites, about 12,000 sign-in emails (confirmations plus re-sends), one welcome per paying founder, and four or five digests a month per paying founder.

- With 2,000 paying founders: about 10,000 + 12,000 + 2,000 + 10,000 = **34,000 in the launch month**, then about 12,000 a month. **Pro, $20 a month** (50,000 included; $0.90 per 1,000 over).
- With 5,000 or more paying founders, digests alone pass 20,000 a month: move to **Pro 100k, $35 a month**.
- Supabase's custom SMTP costs nothing extra; those emails count toward the same Resend plan.
