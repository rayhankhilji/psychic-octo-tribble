# Launch emails

Three emails: the announcement to the whole waitlist, and two invite variants for the waves. Plain, short, honest. Each has a subject, preview text (the grey line inboxes show after the subject) and a body you can send as plain text or lightly formatted HTML.

Before sending:

- Replace everything in `[square brackets]`. Don't invent anything to fill them: if a bracket asks for a number you don't have, cut the sentence.
- **Marketing footer (⚖, see LAUNCH.md):** the announcement is marketing mail, so it needs an unsubscribe link (one-click, `List-Unsubscribe`) and your postal address. The invites are closer to transactional, but give them the same footer; it costs nothing.
- Send from `hello@mail.YOUR-DOMAIN` (or similar), never from the `auth.` subdomain that carries sign-in links.
- Warm-up: send the announcement in batches, oldest sign-ups first, following Resend's warm-up schedule (LAUNCH.md, "Email").
- The waitlist is 10,000 people. Each email should still read as if it were written to one.

---

## 1. Announcement (whole waitlist, a few days before Wave 1)

**Subject:** TinyTown opens on [day, date]
**Preview:** Here's how getting in works, what it costs, and the demo you can play today.

> Hi,
>
> You joined the TinyTown waitlist, so here's the news first: **TinyTown opens on [day, date].**
>
> If you've forgotten: TinyTown turns your startup into a little San Francisco Bay city, built from your real numbers. Every $1 of monthly recurring revenue becomes $10,000 for you to spend on the city. Your customers live there. Your house moves up a rung each time your revenue gains a digit, from a hacker house to, eventually, the moon. And if revenue slips, the city shows that too.
>
> **How getting in works.** We're letting people in in waves over a few days, oldest sign-ups first, so everyone gets a city that works properly. You'll get an email when it's your turn. Sign in with this email address.
>
> **What it costs.** $12 a month, or $99 a year. There's no free trial, and payments aren't refundable; you can cancel any time and keep your city until the end of what you've paid for. We'd rather you decide with the full picture, which is why:
>
> **The demo is free, right now.** It's the whole game running on a sample startup's first 540 days: [YOUR-DOMAIN/?demo]
>
> **What it reads.** TinyTown connects to Stripe through a read-only Stripe App (subscriptions and prices, nothing else) and, if you like, to one GitHub repository (commit dates and releases). It never changes anything, and the city only ever shows real numbers.
>
> [Only if the Stripe App isn't published yet: "One honest caveat: Stripe is still reviewing our Stripe App. Invites start as soon as it's approved, and if that moves the date, you'll hear from me."]
>
> See you in the Bay,
> [Your name]
> TinyTown
>
> ---
> You're getting this because you joined the TinyTown waitlist at [where/when]. [Unsubscribe] · [Postal address]

---

## 2a. Invite: early waves (Waves 0–3)

**Subject:** You're in: build your TinyTown
**Preview:** Your invite is ready. Sign in with this email address to start.

> Hi,
>
> It's your turn. You can build your TinyTown now.
>
> **[Open TinyTown →]** (YOUR-DOMAIN)
>
> Sign in with **this email address** ([email]). The quickest way is "Continue with Google" or "Continue with GitHub", if they use the same address; otherwise we'll email you a sign-in link.
>
> Then:
> 1. **Pick a plan:** $12 a month or $99 a year. No trial and no refunds, but you can cancel any time and keep your city until the end of what you've paid for.
> 2. **Connect Stripe.** You'll install the TinyTown app on Stripe and approve two read-only permissions. Use your **live** account: test-mode data doesn't count.
> 3. **Connect GitHub (optional).** Releases add floors to your HQ; commits speed up the train.
>
> Then your city is built from your history, and you get the last three months of revenue as a grand-opening fund.
>
> You're one of the first people in, so if anything looks wrong, or just odd, reply to this email. I read every one.
>
> [Your name]
> TinyTown
>
> ---
> You're getting this because you joined the TinyTown waitlist. [Unsubscribe] · [Postal address]

---

## 2b. Invite: final wave and opening up

**Subject:** Your TinyTown invite
**Preview:** Everyone on the waitlist is in now, including you.

> Hi,
>
> Thanks for waiting. **Everyone on the waitlist can now build their TinyTown**, you included.
>
> **[Open TinyTown →]** (YOUR-DOMAIN)
>
> Sign in with this email address ([email]), pick a plan ($12 a month or $99 a year), connect Stripe with the read-only TinyTown app, and your city is built from your real numbers. GitHub is optional.
>
> Two things worth knowing before you pay: there's no free trial and no refunds, and you can cancel any time and keep your city until the end of what you've paid for. If you'd like another look first, the demo is still free: [YOUR-DOMAIN/?demo]
>
> Questions? Just reply.
>
> [Your name]
> TinyTown
>
> ---
> You're getting this because you joined the TinyTown waitlist. [Unsubscribe] · [Postal address]
