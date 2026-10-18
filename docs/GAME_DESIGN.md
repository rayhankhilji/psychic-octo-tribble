# TinyTown: game design

Status: **step 1 is playable** in the browser demo (`npm run dev`, saved locally). Numbers below are the ones in `src/game/`. Hosting, live cash from Stripe, flights and the moon trip's destination scene are next.

> **2026-10-14: the ladder is much easier to climb.** The owner found the old ladder (the moon at $1M MRR) out of reach. The founder's house now goes studio **$10**, bungalow or loft **$50**, TinyTown Hills **$250**, estate **$1k**, island **$5k**, the moon **$10k** MRR, and every other gate follows the same curve (`easeMrr` in `src/game/catalog.ts`). Prices scale with their gate, so things take about as many days to afford as before. Unchanged: $1 of MRR is $10,000 of game money, housing needs $0.20 of MRR per user, the starting grant, satisfaction, decay and the one rule. The rule and the before and after are [at the end](#2026-10-14-the-easier-ladder).

## The one rule

**The only way to grow your city is to grow your startup.**

Every in-game dollar comes from real revenue. No in-game action makes money, and you can't buy currency with real money. Satisfaction, land, housing and every unlock trace back to real numbers. The game is the motivation; the business is the controller.

## Core loop

1. Your customers pay you, and the money lands in your city's treasury as **$10,000 per real dollar**.
2. You spend it on buildings, transport, landmarks, vehicles and repairs.
3. Your users live in your city, and housing them costs upkeep every month.
4. If your revenue per user is too low, you can't keep up: people end up on the streets, the bridge rusts and the TINYTOWN sign goes dark at night.
5. Each MRR milestone moves you into a better house, opens new land and unlocks new things to buy.
6. At $250 MRR you can buy a plane to visit other founders' cities.

## Money

### Exchange rate: $1 real = $10,000 in game

$10k is the right rate: one real dollar of MRR is a visible amount of money, and the treasury's numbers feel big without being silly.

| MRR | Monthly city income | What it gets you |
|---|---|---|
| $10 | $100k | A studio of your own; a park or a food truck court every few weeks |
| $50 | $500k | A bungalow or loft, a café, the HQ office |
| $250 | $2.5M | A TinyTown Hills house, a prop plane, the library |
| $1k | $10M | One of three estates, the marina, a Gulfstream-style jet ($7M) |
| $5k | $50M | Your own island and a superyacht, a supertall |
| $10k | $100M a month | A house on the moon, and a rocket ($50M) to get there |

Until 2026-10-14 game prices tracked real-world luxury prices (a $70M jet at $10k MRR, a $2B rocket at $1M). The gates came down a long way and prices came down with them, so a jet is no longer jet-priced; the trade is that every rung is reachable by a real indie business. At $1M per dollar, a founder at $1 MRR would already be a millionaire and nothing would feel earned. At $1k per dollar, the early game is stuck saving up for park benches.

### Income

- **Income is cash actually collected in Stripe** (paid invoices and charges, minus refunds and chargebacks), converted to USD and multiplied by 10,000.
- **It pays out once a day.** When you open the app you get "rent day": a short animation of money flowing into City Hall, plus a *while you were away* summary.
  - Daily, not monthly or real time. Monthly is too slow to bring anyone back. Real time is invisible: numbers tick up and nobody notices.
  - Daily gives a reason to open the app every morning and matches how often we sync Stripe.
- **Nothing expires.** There's no "collect it or lose it": income lands whether you open the app or not. Coming back should feel good, not like a punishment for being busy shipping.
- **Annual plans** are credited when they're paid, because cash is cash. Unlocks are gated on MRR, not treasury, so a big annual payment can't skip progression.

### Getting started

- **Starting grant:** $500k, enough for a park, a café and a couple of repairs, so day one is fun even at $0 MRR.
- **Back pay:** a founder whose city opens (connected and paid; setup is free and can come first) gets the last 3 months of collected revenue as a *grand opening* fund. Full history would let a mature company build everything on day one and skip the game. Their MRR still unlocks everything they've earned, so they start in the right house with the right land open.

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
- **Each user needs $0.20 of real MRR to be housed.** That's your rule: 1,000 users need $200 MRR.
  - At $20 ARPU that means converting at least 1% of active users, which is below typical freemium rates.
  - It's lenient enough that a healthy startup clears it and strict enough that a vanity-metric startup visibly can't.
  - The $0.20 is a tunable constant (`MRR_PER_USER`). Later we could let founders enter their real cost per user.
- **Housing upkeep is $1,000 per housed resident per month in game money** (the first 100 are free). At exactly the $0.20 line, housing eats half your income, so poor conversion leaves little to build with.
- **Homes build themselves, for free.** Density steps down from downtown: apartment blocks near HQ, painted-lady terraces in the middle, houses with pools at the edge. Land is finite, so big populations get denser.
- **A homelessness crisis also runs the city down:** the share of residents without a home drags maintenance down (100% homeless takes 60 points off). Poor conversion shows up as a dark sign and a rusting bridge, not only as tents.
- **Unhoused residents** appear as tents and sleeping bags along park edges, under the bridge and by the train line, with a count on the meter. They're shown plainly, never as a joke. When housing catches up, they move into homes and you see it happen.
- **Friends & family housing:** the first 100 users are always housed. Pre-launch founders shouldn't open the app to a tent city.

## Upkeep and decay

Every building has monthly upkeep: 2% of its build price (3% for planes, yachts and rockets). Housing upkeep is per resident (above). Each day, upkeep is paid from income first, then from the treasury.

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
- **Things decay gradually and recover faster:** maintenance falls at most 2 points a day and recovers up to 4 a day once upkeep is covered again. Repairs are automatic once the money is there. A manual "choose what to fix" mode is a later idea.
- **Comebacks are celebrated.** When the sign relights after a dark spell, it gets a moment and a share prompt. *"Fixed churn. The sign's back on."* is the best video this product will ever produce.

## Citizen satisfaction (0–100)

The score people will obsess over. It has no effect on money, so the only way to raise it is real growth.

| Component | Weight | Driven by |
|---|---|---|
| Housing | 35% | Share of residents housed (MRR per user) |
| Upkeep | 25% | Maintenance level (income vs costs) |
| Amenities | 20% | Parks, transport and entertainment per resident (bought with revenue) |
| Momentum | 20% | Trailing 4-week MRR growth |

- **Visible mood:** happy cities have street festivals, people waving and fireworks on milestones. Unhappy ones have grey crowds and protest signs at City Hall.
- **Public score:** satisfaction can show on your public city page and in the visitor list. It's safer to compete on than MRR, which many founders keep private.

## The founder's house

**A free milestone reward, never bought. Every house you've lived in stays as a landmark.** The shared hacker house becomes "where it all started", with a plaque.

| MRR (peak) | Your home | Where | Value |
|---|---|---|---|
| Sign-up | **Hacker House**: bunk beds, whiteboards, too many cofounders | Downtown | – |
| $10 | Studio apartment, your own front door at last | Downtown | – |
| $50 | **Pick one:** a bungalow with a yard, or a loft apartment | City | $500k |
| $250 | Your first **TinyTown Hills** house: mid-century modern, Spanish Revival or canyon house | The Hills | $5M |
| $1k | **Pick one of three estates:** Spanish villa, glass cliffside house, or modernist compound | Upper Hills | $20M |
| $5k | **Island estate + superyacht** (three to pick from) | Your own island in the bay | $100M |
| $10k | **A house on the moon.** The clouded end of your island clears to reveal a launch site; buy a rocket ($50M) and fly there and back. | The moon | – |

Each value is about two months of income at its gate, so a renovation costs about half a month.

**Swapping a pick** costs a renovation fee in game money (25% of the house's value), never real money. Your MRR earns the option; your treasury pays to change your mind.

## Land: fog clears as you grow

The map starts mostly under cloud. **Regions open at MRR milestones.** Within a region, plots become available as you fill the ones you have: the cloud edge rolls back as you build. Region unlocks need real growth; plots within a region need you to use what you've got.

| Region | Opens at | Highlights |
|---|---|---|
| Downtown blocks | Sign-up (Embarcadero, North Beach), then SoMa $50, Union Square $250, Financial District $750, Rincon Hill $1k, Nob Hill $2k, Transbay $5k | Four plots each. The next block clears only once every open plot is built on **and** MRR has reached its gate. |
| TinyTown Hills | $250 | Switchback road, villas, luxury cars, your Hills house, the sign |
| The pier | $500 | Ferris wheel and roller coaster to buy |
| Harbour & marina | $1k | Yacht berths |
| Your island | $5k | Founder estate and superyacht |
| Launch site (the island's clouded end) | $10k | Rocket pad |

The Hills, the island and the launch site open with the rung of the house ladder that lives there (`REGIONS` reads those gates from `HOME_TIERS`).

**The airport is free infrastructure**, always there for every city. Planes are what you buy.

## What you can build

Each item unlocks at an MRR tier and costs roughly 1–4 months of that tier's income. You can afford a few things at your tier each month, and the next tier's items are about 10× pricier.

| Unlocks at | Items (game money) |
|---|---|
| Sign-up | Community garden $40k · pocket park $50k · corner shops $80k · food truck court $120k |
| $50 | Basketball courts $100k · café & bookshop $150k · co-working space $750k · HQ office building $250k |
| $250 | Prop plane $250k · public library $2M · neon theatre $4M · office tower $6M · tech campus $10M · HQ campus $5M |
| $500 | Ferris wheel $3.5M · pier roller coaster $7.5M |
| $1k | Day yacht $3M · Gulfstream-style jet $7M · skyscraper $25M · amusement park $30M (whole block) · stadium $50M (whole block) · HQ tower $20M |
| $2k | Pyramid tower $65M · concert arena $70M · venture studio $80M (launch your next startups) · university $120M (whole block) |
| $5k | Long-range jet $12M · research institute $100M · supertall $150M (whole block) · HQ landmark tower $100M |
| $10k (the moon) | Supersonic jet $30M · rocket $50M |

**What a city does with $50–100M a month** (about $5k–10k MRR): found a top university, open a research institute, launch new ventures from the venture studio, raise a supertall, build stadiums and an amusement park, and keep everything maintained. More big-ticket projects (a second bridge, a new district across the bay, an international airport) are natural additions.

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

- **Every city has an airport, for free**, so anyone can be visited.
- **Flying needs your own plane.** The first plane unlocks at $250 MRR, so the social loop opens early enough for lots of people to use it. Better planes (Gulfstream at $1k, long-range at $5k, supersonic at $10k) look better and fly faster. Any plane can reach any city.
- **The flight:**
  1. The camera zooms to your airport, where your plane taxis and takes off.
  2. It flies 5–10 seconds over open ocean.
  3. It lands at their airport.
  4. You arrive in their city as a visitor.
- **Visitors can look, never touch.** They can explore, read the founder's public stats (only what that founder chose to share) and leave a **postcard** in the guestbook.
- **You can't move to another city.** Your city *is* your startup. Founders with two startups get two cities and fly between them.

## Pricing

**Paid only, as a subscription.** We never sell in-game currency, speed-ups or unlocks, because that would break the one rule.

- **$29 a year, annual only. No free trial, no refunds.** Checkout shows local currencies (Stripe Adaptive Pricing).
- Open question: a 14-day money-back guarantee would keep "paid only" while removing the risk of paying before seeing your city.
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

1. **Game loop on the demo startup, no accounts. ✅ Built.**
   - Treasury, daily income, the build catalogue on plots, the cloud regions (Downtown + Hills).
   - Housing and unhoused residents, upkeep and decay (sign, lamps, bridge, train), satisfaction.
   - The founder house ladder, wealth-based cars, zoom buttons, a bigger sign on a proper Hollywood Hills.
   - Saved in the browser. **This proves it's fun before we build any infrastructure.**
2. **Hosted.**
   - Accounts, "Connect with Stripe" (OAuth, read-only, no pasted keys), PostHog, GitHub.
   - The server computes the treasury and validates every purchase, so it can't be cheated from the browser.
   - Brand import from URL and subscriptions (Vercel + Supabase).
3. **Flights and visits** (planes can already be bought and parked), and the moon scene at the end of the rocket trip.
4. **More regions, then more cities.**

## 2026-10-14: the easier ladder

The owner: *"1M MRR to go to the moon and all the other benchmarks are massively hard and out of reach. Make everything 10x easier."* Then, final: the house ladder is studio $10, bungalow or loft $50, TinyTown Hills $250, estate $1k, island $5k, moon $10k, *"and then get everything on that wavelength."*

**The rule.** Every MRR gate is `easeMrr(old gate)`, a curve through the ladder's anchors, one per old digit:

| Old gate | $10 | $100 | $1k | $10k | $100k | $1M |
|---|---|---|---|---|---|---|
| New gate | $10 | $50 | $250 | $1k | $5k | $10k |

Between anchors it is log-linear (a gate a third of the way between two digits lands a third of the way between their new values, on a log scale), so the old pier gate of $3k becomes $484, shown as **$500**; the old $5k block becomes $660, shown as **$750**; the old $25k tier becomes $1,897, shown as **$2k**. The tables hold the rounded numbers; `easeMrr` and `EASE_ANCHORS` in `src/game/catalog.ts` hold the curve, and a test pins the ladder to it.

**Prices** scale with their gate: `new price = old price × new gate / old gate`, rounded to a friendly number, so each thing takes about as many days of income to afford once it unlocks. House values follow the same rule. Ungated starter items ($40k–$120k) and the $500k starting grant don't change.

**Three exceptions, the planes and the rocket.** The rule would price the long-range jet at $6M, the supersonic jet at $5M and the rocket at $20M: each plane cheaper than the one below it, and the moon a formality (two days of income). They cost $12M, $30M and $50M instead, so every plane costs more than the last and the rocket is about two weeks of income at the moon gate.

**What didn't change.** $1 of MRR = $10,000 a month of game money, paid daily. Housing at $0.20 of MRR per user and $1,000 upkeep per housed resident. The starting grant, back pay, satisfaction, decay, and the one rule. The milestones the feed celebrates with fireworks ("MRR passed $10k") are real round numbers, so they didn't move.

**Saved cities.** Every gate and every price is lower or equal, so every choice a founder saved under the old tables still applies (checked by replaying 1,114 accepted actions from 60 random cities: none rejected). Founders find themselves further up the ladder, with more in the treasury.

**When things open, before → after** (day of the timeline; "–" = never):

| | Plain demo (540 days, ends at $26k MRR) | Indie: $0 → $15k over 3 years | Venture: $1k growing 12% a month for 4 years |
|---|---|---|---|
| Bungalow or loft | 53 → 39 | 20 → 20 | 0 → 0 |
| TinyTown Hills | 174 → 57 | 210 → 52 | 0 → 0 |
| The pier | 247 → 89 | 348 → 130 | 291 → 0 |
| An estate, the marina | 404 → 174 | 577 → 210 | 610 → 0 |
| Your island | – → 307 | – → 424 | 1,220 → 427 |
| The moon and launch site | – → 404 | – → 577 | – → 610 |

**Pacing.** A simulated greedy player (once a week, buys the best thing it can afford) buys something from each new tier within days of it opening, as before: in the plain demo the prop plane 6 days after the Hills open (before: 1), the Ferris wheel 9 days after the pier (before: 5), a yacht 1 day after the marina (before: 2), the rocket 2 days after the moon (the boosted demo bought it the same day). Maintenance stays at 100% and satisfaction lands where it did.

**The demo.** The scripted Nightjar founder now climbs the whole ladder without a boost: the island on day 307 ($5k MRR, "Day 308" on the scrubber) and **the moon on day 404** ($10k MRR, "Day 405"), with the rocket on the pad on day 411. The script also builds the pyramid tower, venture studio, university, long-range jet, HQ landmark tower and supersonic jet: 29 builds, all affordable in the plain demo, none rejected. `&boost=40` still works and reaches the moon on day 57.
