# TinyTown: product thesis

> A Tamagotchi for your startup.

## The bet

Founders already have charts. They don't need another one. But many people enjoy watching something they built turn into a world. TinyTown changes how a founder relates to their progress: less spreadsheet, more little kingdom.

It's connected to real metrics and never pretends. The city illustrates the numbers; the numbers are always one glance away.

## Why it might sell

- **It's personal.** It's tied to the thing the buyer cares about most right now.
- **It's shareable by design.** *"I connected my startup to TinyTown. Every customer is a resident and my company is now a little sunny city by the bay."* That clip is the ad, and other founders see the product before they visit the site.
- **It's delightful.** Founders pay for things that make the grind feel good.

The commercial hypothesis is simple, and it's untested: enough founders value the delight enough to pay for it month after month.

## What we're building first

| | v0 (this repo) | Next |
| --- | --- | --- |
| World | One art direction: a toy-sized San Francisco Bay laid out like the real one (downtown, Market Street, the Embarcadero, the Golden Gate and Bay Bridge, SFO) with a TINYTOWN sign on the hill, on a day/night cycle that follows the viewer's local clock | More hand-made detail before any second theme |
| Integrations | Stripe (customers, MRR, full history), GitHub (releases, commits) | PostHog (active users), Supabase (signups) |
| Events | First customer, every join and churn, MRR milestones, releases, pushes, rough weeks | Founder-defined milestones ("first enterprise deal") |
| Social | Snapshot PNG, metrics hidden by default | Public world page, 15-second growth recap video |
| Surface | Web app with self-hosted key proxy | Hosted accounts with OAuth connections, desktop mode |

We start with two integrations, not ten. One world done exquisitely beats twenty themes nobody asked for.

## Craft bar

Not allowed: generic emoji, gradient backgrounds, AI-generated city pictures, or a dashboard with a few buildings pasted on.

Required: a real interactive scene on a proper rendering engine, with a recognisable art direction and small details that reward exploring. It should look like a premium indie game, built by someone who tracks metrics as obsessively as a founder does.

## Monetisation (hypotheses to test)

- **Free:** one basic world.
- **Paid:** live integrations, custom themes, historical progression, desktop mode and better sharing.

The first hypothesis was around $8–$12 a month. **Decided (2026-10-14): $29 a year, annual only**, with no free trial (the demo is free) and no refunds. A hundred paying customers is $2,900 ARR. The price is the owner's call, not established willingness to pay: watch conversion from the plan sheet.

## The real risk: retention

Novelty wears off. The world has to stay interesting as the business develops:

- **Always a next thing.** The fenced lot for the next milestone stays visible.
- **History is content.** Replaying your story from day one only gets better with time.
- **Bad weeks matter too.** Rain and dimmed districts make the world honest, which is what makes the good days feel earned.
- **Rituals.** A weekly recap ("this week in Nightjar") gives people a reason to come back.

## How we'll know

1. **Launch video test.** Connect our own startup and post the growth replay. Watch saves, replies and "how do I get this" DMs, not likes.
2. **Waitlist to connect.** What share of sign-ups actually connect Stripe or GitHub?
3. **Week-4 return rate** among connected users. This is the retention question in one number.
4. **Paid conversion at $9.** Run a smoke test before building the paid tier fully.
5. **Share rate.** What share of active users export a snapshot each month? This tests whether the growth loop exists.
