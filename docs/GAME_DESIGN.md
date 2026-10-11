# TinyTown: game design

Status: **step 1 is playable** in the browser demo (`npm run dev`, saved locally). Numbers below are the ones in `src/game/`. Hosting, live cash from Stripe, flights and the moon trip's destination scene are next.

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

| MRR | Your home | Where |
|---|---|---|
| Sign-up | **Hacker House**: bunk beds, whiteboards, too many cofounders | Downtown |
| $10 | Studio apartment, your own front door at last | Downtown |
| $100 | **Pick one:** a bungalow with a yard, or a loft apartment | City |
| $1k | Your first **TinyTown Hills** house, a mid-century modern with a pool | The Hills |
| $10k | **Pick one of three estates:** Spanish villa, glass cliffside house, or modernist compound | Upper Hills |
| $100k | **Island estate + superyacht** | Your own island in the bay |
| $1M | **A house on the moon.** The clouded end of your island clears to reveal a launch site; buy a rocket and fly there and back. | The moon |

**Swapping a pick** costs a renovation fee in game money (25% of the house's value), never real money. Your MRR earns the option; your treasury pays to change your mind.

## Land: fog clears as you grow

The map starts mostly under cloud. **Regions open at MRR milestones.** Within a region, plots become available as you fill the ones you have: the cloud edge rolls back as you build. Region unlocks need real growth; plots within a region need you to use what you've got.

| Region | Opens at | Highlights |
|---|---|---|
| Downtown blocks | Sign-up, then $100, $1k, $5k, $10k, $25k, $100k | Four plots each. The next block clears only once every open plot is built on **and** MRR has reached its gate. |
| TinyTown Hills | $1k | Switchback road, villas, luxury cars, your Hills house, the sign |
| The pier | $3k | Ferris wheel and roller coaster to buy |
| Harbour & marina | $10k | Yacht berths |
| Your island | $100k | Founder estate and superyacht |
| Launch site (the island's clouded end) | $1M | Rocket pad |

**The airport is free infrastructure**, always there for every city. Planes are what you buy.

## What you can build

Each item unlocks at an MRR tier and costs roughly 1–4 months of that tier's income. You can afford a few things at your tier each month, and the next tier's items are about 10× pricier.

| Unlocks at | Items (game money) |
|---|---|
| Sign-up | Community garden $40k · pocket park $50k · corner shops $80k · food truck court $120k |
| $100 | Basketball courts $200k · café & bookshop $300k · co-working space $1.5M · HQ office building $500k |
| $1k | Prop plane $1M · public library $8M · neon theatre $15M · office tower $25M · tech campus $40M · HQ campus $20M |
| $3k | Ferris wheel $20M · pier roller coaster $45M |
| $10k | Day yacht $30M · Gulfstream-style jet $70M · skyscraper $250M · amusement park $300M (whole block) · stadium $500M (whole block) · HQ tower $200M |
| $25k | Pyramid tower $800M · concert arena $900M · venture studio $1B (launch your next startups) · university $1.5B (whole block) |
| $100k | Long-range jet $120M · research institute $2B · supertall $3B (whole block) · HQ landmark tower $2B |
| $1M | Supersonic jet $500M · rocket $2B |

**What a city does with $1B a month** (about $100k MRR): found a top university, open a research institute, launch new ventures from the venture studio, raise a supertall, build stadiums and an amusement park, and keep everything maintained. More big-ticket projects (a second bridge, a new district across the bay, an international airport) are natural additions.

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

- **$12/month or $99/year. No free trial.**
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
