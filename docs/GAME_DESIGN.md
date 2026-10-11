# TinyTown: game design

Status: draft for review. Nothing here is built yet.

## The one rule

**The only way to grow your city is to grow your startup.**

Every in-game dollar comes from real revenue. No in-game action makes money, and you can't buy currency with real money. Satisfaction, land, housing and every unlock trace back to real numbers. The game is the motivation; the business is the controller.

## Core loop

1. Your customers pay you, and the money lands in your city's treasury as **$10,000 per real dollar**.
2. You spend it on buildings, transport, landmarks, vehicles and repairs.
3. Your users live in your city, and housing them costs upkeep every month.
4. If your revenue per user is too low, you can't keep up: people end up on the streets, the bridge rusts and the TINYTOWN sign goes dark at night.
5. Each new digit of MRR moves you into a better house, opens new land and unlocks new things to buy.
6. At $1k MRR you can fly a plane to visit other founders' cities.

## Money

### Exchange rate: $1 real = $10,000 in game

$10k is the right rate. In-game money then tracks real-world luxury prices at the right moments:

| MRR | Monthly city income | Feels like |
|---|---|---|
| $10 | $100k | A small-business owner |
| $100 | $1M | A millionaire |
| $1k | $10M | Can afford a plane |
| $10k | $100M | Can afford a Gulfstream |
| $100k | $1B a month | A billionaire, which fits the island estate and superyacht |
| $1M | $10B a month | Has a space programme |

At $1M per dollar, a founder at $1 MRR would already be a millionaire and nothing would feel earned. At $1k per dollar, the early game is stuck saving up for park benches.

### Income

- **Income is cash actually collected in Stripe** (paid invoices and charges, minus refunds and chargebacks), converted to USD and multiplied by 10,000.
- **It pays out once a day.** When you open the app you get "rent day": a short animation of money flowing into City Hall, plus a *while you were away* summary.
  - Daily, not monthly or real time. Monthly is too slow to bring anyone back. Real time is invisible: numbers tick up and nobody notices.
  - Daily gives a reason to open the app every morning and matches how often we sync Stripe.
- **Nothing expires.** There's no "collect it or lose it": income lands whether you open the app or not. Coming back should feel good, not like a punishment for being busy shipping.
- **Annual plans** are credited when they're paid, because cash is cash. Unlocks are gated on MRR, not treasury, so a big annual payment can't skip progression.

### Getting started

- **Starting grant:** $500k, enough for a park, a café and a couple of repairs, so day one is fun even at $0 MRR.
- **Back pay:** a founder who connects an existing business gets the last 3 months of collected revenue as a *grand opening* fund. Full history would let a mature company build everything on day one and skip the game. Their MRR still unlocks everything they've earned, so they start in the right house with the right land open.

### Spending

The treasury never goes negative. Running short doesn't create debt; it causes decay (below).

## Population and housing

This is the conversion-rate mechanic, and it's simpler than it sounds. The founder sees **one meter**:

> **Housing:** 1,000 users need $200 MRR. You're at $150 → 250 people without a home.

How it works under the hood:

- **Population = your monthly active users.**
  - Not all-time signups. A five-year-old product would be punished forever for people who left years ago.
  - Sources, in order of preference: PostHog, Supabase auth, a manual number you update, or (if nothing else is connected) your paying customers.
  - If only Stripe is connected, everyone is a paying customer, so everyone is housed. We never invent users.
- **Housing upkeep is $2,000 per resident per month in game money**, which is $0.20 of real MRR per user. That's your rule: 1,000 users need $200 MRR.
  - At $20 ARPU that means converting at least 1% of active users, which is below typical freemium rates.
  - It's lenient enough that a healthy startup clears it and strict enough that a vanity-metric startup visibly can't.
  - The $0.20 is a tunable constant. Later we could let founders enter their real cost per user.
- **Housing is built automatically by default.** The city builds homes for new residents when the treasury allows.
  - You can turn auto-housing off and choose types yourself.
  - At scale you *have* to upgrade density, because land is limited: house (4 people), terrace (12), apartment block (120), residential tower (1,000).
- **Unhoused residents** appear as tents and sleeping bags along park edges, under the bridge and by the train line, with a count on the meter. They're shown plainly, never as a joke. When housing catches up, they move into homes and you see it happen.
- **Friends & family housing:** the first 100 users are always housed. Pre-launch founders shouldn't open the app to a tent city.

## Upkeep and decay

Every building has monthly upkeep, roughly 1% of its build price. Housing upkeep is per resident (above). Each day, upkeep is paid from income first, then from the treasury.

If upkeep isn't fully funded, the city's **maintenance level** drops below 100%. Things decay in this order, so the warning signs come first and are the most visible:

| Maintenance | What happens |
|---|---|
| < 95% | **The TINYTOWN sign goes dark at night.** The lights were the first thing cut, like the real Hollywood sign. |
| < 85% | Street lamps flicker and some fail. Potholes appear. |
| < 75% | The bridge rusts, loses its paint and gets traffic cones. |
| < 60% | The train stops running and the station gets a "service suspended" sign. |
| < 50% | Shops board up. Offices get *for lease* banners. |
| < 35% | Housing fails, which adds to the unhoused count. |

- **Nothing is ever destroyed.** Decay dims, rusts and closes things, and lowers satisfaction.
- **Repairs cost money.** "Auto-repair" (on by default) fixes things as soon as funds allow. Turn it off to choose what gets fixed first.
- **Comebacks are celebrated.** When the sign relights after a dark spell, it gets a moment and a share prompt. *"Fixed churn. The sign's back on."* is the best video this product will ever produce.

## Citizen satisfaction (0–100)

The score people will obsess over. It has no effect on money, so the only way to raise it is real growth.

| Component | Weight | Driven by |
|---|---|---|
| Housing | 35% | Share of residents housed (MRR per user) |
| Upkeep | 25% | Maintenance level (income vs costs) |
| Amenities | 20% | Parks, transport and entertainment per resident (bought with revenue) |
| Momentum | 20% | Trailing 4-week growth in MRR and active users |

- **Visible mood:** happy cities have street festivals, people waving and fireworks on milestones. Unhappy ones have grey crowds and protest signs at City Hall.
- **Public score:** satisfaction can show on your public city page and in the visitor list. It's safer to compete on than MRR, which many founders keep private.

## The founder's house

**A free milestone reward, never bought. Every house you've lived in stays as a landmark.** The shared hacker house becomes "where it all started", with a plaque.

| MRR | Your home | Where |
|---|---|---|
| Sign-up | **Hacker House**: bunk beds, whiteboards, too many cofounders | Downtown |
| $10 | Studio apartment, your own front door at last | Downtown |
| $100 | **Pick one:** a bungalow with a yard, or a loft apartment | City |
| $1k | Your first **TinyTown Hills** house, a mid-century modern with a pool | The Hills |
| $10k | **Pick one of three estates:** Spanish villa, glass cliffside house, or modernist compound | Upper Hills |
| $100k | **Island estate + superyacht** | Your own island in the bay |
| $1M | **To discuss:** a launch pad on the island? A floating city? | Island |

**Swapping a pick** costs a renovation fee in game money (25% of the house's value), never real money. Your MRR earns the option; your treasury pays to change your mind.

## Land: fog clears as you grow

The map starts mostly under cloud. **Regions open at MRR milestones.** Within a region, plots become available as you fill the ones you have: the cloud edge rolls back as you build. Region unlocks need real growth; plots within a region need you to use what you've got.

| Region | Opens at | Highlights |
|---|---|---|
| Downtown | Sign-up | HQ, offices, shops, first homes |
| TinyTown Hills | $1k | Founder houses, villas, the sign, winding roads |
| Airfield | $1k | Airstrip, hangars |
| Boardwalk & pier | $3k | Amusement park, Ferris wheel, arcade |
| Harbour & marina | $10k | Shipyard, docks, yachts, ferries |
| Northside (across the bridge) | $25k | A second district: stadium, campus, skyline |
| Your island | $100k | Founder estate, superyacht berth |
| Space coast | $1M | Launch pad (to discuss) |

## What you can build

Each item unlocks at an MRR tier and costs roughly 1–4 months of that tier's income. You can afford a few things at your tier each month, and the next tier's items are about 10× pricier.

| Unlocks at | Examples (game money) |
|---|---|
| Sign-up | Park $50k · food truck $20k · bus stop $10k · street repair $5k · small shop $80k |
| $100 | Café $300k · co-working office $1.5M · starter apartment block $2M (120 people) · basketball court $200k · tram segment $1M |
| $1k | Office tower $25M · **airstrip $5M** · **prop plane $1M** · Hills plots · marina dock $8M |
| $10k | Skyscraper $250M · new train line $200M · shipyard $150M · amusement park $300M · stadium $500M · **airport terminal $150M** · **Gulfstream-style jet $70M** · day yacht $30M |
| $100k | Supertall $3B · international airport $5B · long-range jet $120M · second bridge $2B |
| $1M | Supersonic jet $500M (flies faster, sonic boom) · launch pad $10B (to discuss) |

**HQ upgrades** are bought too: garage → office floor → campus → tower → landmark tower. They're gated by MRR and decorated with your brand (below). Releases still add floors, as now.

## Cars

- **Cars match the neighbourhood.**
  - Downtown: hatchbacks, taxis, delivery vans and buses.
  - The Hills: convertibles, SUVs and the occasional supercar.
  - The island: golf buggies and one hypercar.
- **More wealth, more luxury.** The mix shifts toward expensive cars as satisfaction and MRR rise.
- **Your own car** parks outside your house, and it upgrades with your house tier.

## Your brand on HQ

- **Sign-up asks for your startup's name and URL.** The city is named after your startup, and you can change that later.
- **We read your site** for its logo (favicon or apple-touch-icon, falling back to the og:image), its brand colour (theme-color meta or main CSS colour) and its title.
- **HQ wears your brand:** your logo on a rooftop sign post, your brand colour on the glass and neon, your name on the plaza.
- **Low-res or missing logo:** fall back to a clean wordmark of your name. Any logo can be replaced by an upload.

## Flights and visiting other founders

- **Every city has a public airport**, so anyone can be visited.
- **Flying needs your own plane.** The first plane unlocks at $1k MRR, so the social loop opens early enough for lots of people to use it. Better planes (Gulfstream at $10k, long-range at $100k, supersonic at $1M) look better and fly faster. Any plane can reach any city.
- **The flight:**
  1. The camera zooms to your airport, where your plane taxis and takes off.
  2. It flies 5–10 seconds over open ocean.
  3. It lands at their airport.
  4. You arrive in their city as a visitor.
- **Visitors can look, never touch.** They can explore, read the founder's public stats (only what that founder chose to share) and leave a **postcard** in the guestbook.
- **You can't move to another city.** Your city *is* your startup. Founders with two startups get two cities and fly between them.

## Pricing

**Paid only, as a subscription.** We never sell in-game currency, speed-ups or unlocks, because that would break the one rule.

- Proposed: **$12/month or $99/year**, with a **14-day free trial**. The aha moment ("I connected Stripe and saw my city") has to happen before the card.
- Later, possibly: cosmetic-only extras such as plane liveries, house paint and seasonal decorations. Never anything that touches money, land, housing or unlocks.

## Edge cases

| Case | Handling |
|---|---|
| Pre-revenue | Starting grant, hacker house, friends & family housing for the first 100 users. Nothing decays while there's nothing to maintain. |
| Users but no revenue | People end up unhoused after the first 100. That's the honest message. |
| Revenue but no user data | Population = paying customers; all housed. The meter says "connect PostHog to see your real population". |
| Huge companies | Density tiers keep land finite; numbers abbreviate ($12.4B, 3.1M residents). |
| Refunds and chargebacks | Debited from the treasury, down to zero but never below. |
| Paying yourself through Stripe to farm money | Possible, but it costs real money plus fees. It's equivalent to buying currency, which we don't sell. Leaderboards use MRR, not treasury. Test-mode keys are rejected. |
| MRR falls below a tier | You keep your house and everything built. New purchases at that tier lock until you're back. Upkeep pressure does the rest. |
| Long absence | Income keeps arriving and upkeep is paid automatically. Decay happens only from a real deficit, never from not logging in. |
| Multi-currency | Everything is converted to USD at the day's rate before the ×10,000. |
| Annual plans | Credited when collected. Gates use MRR, so a big annual payment can't skip progression. |

## Build order

1. **Game loop on the demo startup, no accounts.**
   - Treasury, daily income, the build catalogue on plots, the cloud regions (Downtown + Hills).
   - Housing and unhoused residents, upkeep and decay (sign, lamps, bridge, train), satisfaction.
   - The founder house ladder, wealth-based cars, zoom buttons, a bigger sign on a proper Hollywood Hills.
   - Saved in the browser. **This proves it's fun before we build any infrastructure.**
2. **Hosted.**
   - Accounts, "Connect with Stripe" (OAuth, read-only, no pasted keys), PostHog, GitHub.
   - The server computes the treasury and validates every purchase, so it can't be cheated from the browser.
   - Brand import from URL, subscriptions and the trial.
3. **Harbour, airfield, planes, flights and visits.**
4. **More regions, then more cities.**
