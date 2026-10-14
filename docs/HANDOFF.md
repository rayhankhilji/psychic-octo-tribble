# TinyTown handoff: the project brain

This is everything a new session needs to continue without the original conversation: what we're building, how we got here, every decision and why, what the owner cares about, and exactly where the work stands. Keep the **Current state** section current as you work.

---

## 1. The product in one page

**TinyTown: your startup, as a living world.** A beautiful little isometric city that is wired to a startup's real metrics. It's not a dashboard and not a chatbot. It's "a Tamagotchi for your startup".

- **The emotional bet.** Founders already have charts. Seeing what you've built become a little kingdom is a different, more personal relationship with progress, and it's inherently shareable. The marketing is a founder posting a clip: *"I connected my startup to TinyTown; every customer is a resident."*
- **The game (added on day one, at the owner's request).**
  - Every real **$1 of MRR = $10,000** of in-game money, paid daily, to spend on the city: offices, parks, towers, a stadium, a university, planes, yachts, a rocket.
  - Your **active users live in the city**. Each needs **$0.20 of MRR** to be housed (1,000 users need $200 MRR). Below that, people end up homeless in tents and the city decays: the TINYTOWN sign goes dark, lamps fail, the bridge rusts, the train stops, shops board up. This pushes the founder toward a real conversion rate.
  - **The founder's own house** moves up as MRR grows (the owner's ladder of 2026-10-14): Hacker House → studio ($10) → bungalow or loft ($50) → a TinyTown Hills house ($250) → one of three estates ($1k) → island estate and superyacht ($5k) → a house on the moon ($10k; buy a rocket to visit).
  - **Land is under cloud.** Regions open at MRR milestones, and within a region more plots clear as you fill the ones you have.
  - **Satisfaction (0–100)** comes from housing, upkeep, amenities and momentum. Nothing in the game can raise it except growing the business.
  - **The one rule:** the only way to grow the city is to grow the startup. We never sell in-game money, speed-ups or unlocks.
- **Real metrics drive the world.** Stripe gives MRR and customers. GitHub releases add HQ floors, and commits speed up the train. Rain falls when MRR drops more than 1% in a week. PostHog (active users) and Supabase (signups) come later.
- **Business model.** Paid only: **$29 a year, annual only, no free trial, no refunds** (owner, 2026-10-14; it was $12/month or $99/year). Cosmetics might come later, but never anything that touches money, land, housing or unlocks.
- **Hosting plan.** Vercel + Supabase for accounts, saves and billing. Not built yet; today, saves live in localStorage.

The full numbers are in `docs/GAME_DESIGN.md`. The thesis and risks are in `docs/PRODUCT.md`.

---

## 2. The owner

- **Who:** the founder building TinyTown (GitHub `rayhankhilji`). They write fast and informally, with typos and slang ("bro", "tokenmaxx to the moon"). Read for intent, not wording.
- **Taste and standards.**
  - Extremely high visual bar. The first version was rejected as **"all slop for fucks sake"**. The latest brief: *"Animation quality, 3d asset quality, branding, design, attention to detail, and the overlay it all needs a massive boost… the quality of all the 3d models, the cars, the houses, the city, the plane, the way the city is laid out looks terrible as well. it should look more like the bay area of SF layout. much higher quality, attention to detail. in fact tokenmaxx to the moon please."*
  - They want it to look and feel like **a premium indie game**: a recognisable **sunny San Francisco Bay** (originally an SF/LA mix with a Hollywood-style **TINYTOWN** sign on a hill), a **day/night cycle following the viewer's local clock**, and a real evening.
  - They love ambitious ideas: jets, yachts, a private airport, rockets, the moon, a $200M amusement park, universities.
- **How they like to work.**
  - For big design changes they want to **talk first**: "can we talk about this first, ask me any and all questions, recommend me suggestions". When they say "idk, what do u think", give a clear recommendation with reasons, not a menu.
  - For build work they want **momentum**: "Start, please", "Continue building", "tokenmaxx". They're happy for Claude to run several parallel agents.
  - They want to **try it themselves**: always end with how to run it and what to look at.
  - They push back when they disagree, and accept well-argued pushback.

---

## 3. History: how we got here

| # | Phase | What happened | Commit(s) |
|---|---|---|---|
| 1 | **Original build** | From the owner's pitch: a three.js isometric "late-night Silicon Valley" city wired to Stripe and GitHub through a small Node server, with a demo world (*Nightjar*, 540 days of a fictional startup), replay timeline, events feed and share image. | early commits |
| 2 | **"That's all slop": sunny redo** | Rebuilt as **Golden Coast**, a sunny SF/LA mix with painted ladies, stucco, palms, a red suspension bridge, a pier with a Ferris wheel, and a **TINYTOWN** sign on the hill. Day/night follows the local clock (`src/world/daylight.ts`), with `?time=` and a clock-chip preview. | `22a8627` |
| 3 | **Gamification design** | Long Q&A with the owner (§4), written up as `docs/GAME_DESIGN.md`. | `32ac28b` |
| 4 | **Game engine + game UI** | Treasury, daily income, the build catalogue on plots, cloud regions, housing and unhoused residents, upkeep and decay (sign, lamps, bridge, train), satisfaction, the founder house ladder, wealth-based cars, zoom buttons, a Hollywood-Hills-style neighbourhood. Saved in the browser. | `c725513`, `e4be703` |
| 5 | **Bay Area layout** | Replaced the generic map with a stylised **San Francisco peninsula** (`src/world/map.ts`): downtown and FiDi in the NE, Market Street on its real diagonal to Civic Center, the Embarcadero, Ferry Building, Coit Tower, North Beach, the Marina, Palace of Fine Arts, the Presidio, Golden Gate Bridge, Golden Gate Park with windmill, the Sunset to Ocean Beach, Twin Peaks with Sutro Tower and the sign, the Bay Bridge via Yerba Buena and Treasure Island, Marin, the East Bay, Angel Island, an SFO-style airport. New post pipeline: GTAO, bloom, tilt-shift, grade. | `82fd4e5` |
| 6 | **Visual overhaul ("tokenmaxx")** | Done by the lead agent plus four parallel agents (§6): batched homes; construction sites; bay life (ferries, sailboats, container ship, airliners, cable cars, F-line, gulls, kites, Karl the Fog, cloud shadows); fireworks; City Hall; Market Street flatirons; SF homes and trees; downtown towers, items, HQ, founder homes and vehicles; traffic and pedestrians; a full UI and brand redesign; darker nights; rain that follows the camera; the moon during rocket flights. | `1b9784e`, `0627a6d`, `4a161d9` and later |
| 7 | **Handoff** | These docs, the `tools/` screenshot scripts, and a SessionStart hook for cloud sessions. | this commit |

---

## 4. Decisions and why (the important ones)

| Decision | Why | Status |
|---|---|---|
| **$1 MRR = $10,000** in game | At $10k MRR the city earns $100M a month (the ladder was made easier on 2026-10-14; it was $1B a month at $100k). At $1 = $1M, nothing feels earned. | Built |
| **Income once a day**, with a "while you were away" summary | Monthly is too slow to bring anyone back; real-time ticking is invisible. Daily gives a reason to open the app each morning. Absence is never punished. | Daily income built; the summary isn't |
| **Housing costs $0.20 MRR per active user**; the first 100 users are always housed | The owner's idea, kept: it makes conversion rate visible. Count monthly actives, not all-time signups. | Built (the demo uses its own user numbers; PostHog not connected yet) |
| **Homelessness stays**, shown with dignity (tents under the bridge and by the tracks, never a joke) | Claude suggested softening it to vacancies and campers. The owner kept it: it plainly tells you you're not converting. | Built |
| **Decay in stages:** sign dark → lamps fail → bridge rusts → train stops → shops board up → housing fails. Nothing is destroyed; it all recovers | The sign going dark is the Hollywood-sign reference. Comebacks ("we fixed churn and the sign came back on") are shareable moments. | Built (the relit-sign celebration and share prompt aren't) |
| **House ladder** (see §1), one rung per digit | The owner's design, shifted down one rung at their request. Old houses stay as landmarks. Picks can be swapped for a 25% renovation fee in game money. | Built (swap fee: check the game UI) |
| **$10k MRR = house on the moon** (was $1M before 2026-10-14); the clouded end of your island clears to a launch site, and you buy a rocket that flies there and back | The owner's idea. | Rocket launch and landing built; the moon appears in the sky during flights. **A moon scene (landing, visiting the house) isn't built.** |
| **The airport is free infrastructure; planes are bought** | The owner's call. | Built |
| **Flights visit other founders' cities.** Every city has an airport, and any plane can fly anywhere once bought. Cinematic: zoom to your airport, take off, 5–10 s over the ocean, land in their city. Visitors can look but not touch, and can leave a postcard. You can't move cities. | Turns the jet into the social and viral feature. | **Not built** (needs hosting) |
| **Build on fixed plots** (four per downtown block, some items take a whole block), not free placement | Free placement is months of work and makes ugly cities. Plots keep every city beautiful and work on phones. | Built |
| **Land clears as you grow:** regions open at MRR gates (Hills $250, pier $500, marina $1k, island $5k, launch site $10k); downtown blocks clear when every plot is built **and** MRR reaches the gate | The owner's idea: "after u use every allocated space more lots open… clouds clear". | Built |
| **Satisfaction score** | The owner wanted an addictive score where the only way up is growing the real startup. | Built |
| **Wealth-based cars:** taxis downtown, convertibles in the Hills, more luxury cars as the city gets richer | The owner's request. | Built in traffic (`setLuxury`) |
| **Your brand on HQ:** sign up with name and URL; we pull the logo and colour, and HQ wears a rooftop logo sign | The owner's idea. | Name sign built; **URL and logo import aren't** |
| **Paid only, $29 a year (annual only), no free trial, no refunds** | The owner's call (2026-10-14; was $12/mo or $99/yr). An impulse price for a delight product; annual avoids novelty churn. | Built |
| **An easier ladder** (2026-10-14) | The owner found $1M MRR for the moon out of reach. Houses: studio $10, bungalow $50, Hills $250, estate $1k, island $5k, moon $10k MRR; every other gate follows the same curve and prices scale with their gate. $1 of MRR = $10,000 and housing at $0.20 per user are unchanged. | Built |
| **Composio vs native connectors** | The owner prefers Composio if it gives the data we need (founders trust a bigger name). Evaluated in `docs/CONNECTORS.md`. | See CONNECTORS.md |
| **Hosting: Vercel + Supabase** | The owner OK'd it. Don't buy a domain without asking. | Not built |
| **The world is the San Francisco Bay** (no longer an LA mix) | The owner: "it should look more like the bay area of SF layout". The TINYTOWN sign stays, on Twin Peaks. | Built |
| **Day/night from the viewer's local clock**, with a real evening | The owner's request. | Built |
| **Build order:** game loop on the demo with no accounts (prove it's fun) → hosting (accounts, Stripe OAuth, PostHog, GitHub, brand import, billing, server-validated purchases) → flights and visits, moon scene → more regions, then more cities | Agreed with the owner. | Step 1 done, plus the visual overhaul |

---

## 5. Current state (update this as you work)

**Branch:** `claude/friendly-darwin-sjkcz1` (second session; it continues from `claude/tender-keller-mnunoy`). `main` exists (created 2026-10-13 with the owner's go) and is the production branch: Vercel deploys it and CI migrates the database from it. The owner opened PR #1.

**Health:** `npm run typecheck` clean, `npm test` ~535 passing, `npm run build` succeeds (app ~223 kB gzip, three.js 170 kB, plus lazy chunks: hosted shell 18 kB, supabase 58 kB, admin 15 kB); `node server/build-vercel.mjs` passes its smoke test with three crons. Grown city (day 540, `quality=high`): ~260 draw calls (was 755) and ~2.3M triangles counting the shadow pass. PR #1 (`claude/friendly-darwin-sjkcz1` → `claude/tender-keller-mnunoy`) was opened by the owner; CI runs typecheck, tests and build.

**Second session (2026-10-12/13), in order:** perf pass (generalised `Batch`); boosted-demo rocket fix; night fixes (clouds, lighthouse beam, Ferry Building, glass flatirons); Daly City and East Bay as terraced streets; scenery tooltips wired; cars give way to streetcars; fading car shadows; bundle split; "while you were away" (logic + card); milestone fireworks shows; festival/protest mood on Civic Center Plaza; the models agent's trims and polish (rocket, yacht, Concorde, ballpark, founder-home rooftops, encampment); the UI agent's accessibility, renovation fee, short-screen rail, lazy thumbnails and night postcard; **the lag fix** (the replay was silently rebuilding thousands of homes; building is now frame-budgeted; lighter GPU defaults); the **TinyTown Hills redesign** with a new house family (`render/hills.ts`); Treasure Island, the Bay Bridge east span and Oakland rebuilt.

**Reference-image push (2026-10-13, in progress):** the owner sent reference images (the Silicon Valley title slide is the target) and a list of complaints. Done and committed: frame pacing and a hover-raycast throttle for CPU; the Places menu; downtown and brand assets; mansion choices (three Hills houses, three island estates, 25% renovation fee); neighbourhoods with one street style per block and a shared building line. Also committed: the landscape (Hills on contour streets, Twin Peaks, backdrop towns, the airport, a bigger island, Treasure Island) and the founder's helicopter (airport pad → estate pad, camera follows). Then the bay (whole, grounded bridges, marquee bulbs on the sign, new boats and landmarks) and the launch site moved off the estate's sightline. All four agents are integrated; grown city ~250 draw calls, ~2.2M triangles including the shadow pass. See TODO P1 for leftovers.

**Launch build (2026-10-13):** the owner is going live to a 10,000-person waitlist and asked for everything to be ready: "infra, billing, payments, accounts, portals, pipelines, data, systems". Decisions: **no refunds** (no money-back guarantee), drop "different building layouts". Thirteen agents built it in parallel, each in its own files; the lead integrated and committed each in a clean worktree. Now in the repo:

- **Seeded cities** (`src/world/worldgen.ts`): every founder's map differs; same plots and economy; seed 0 is the classic map.
- **Hosted product:** Supabase accounts; Stripe Checkout ($29 a year, annual only, no trial, no refunds) with the portal and a hardened webhook; our Stripe App and GitHub App for founders' data; PostHog or a manual number for users; server-checked saves; export and deletion; branded email through Resend with a weekly digest; hourly/daily/weekly pipelines with stored history; the waitlist gate and `/admin.html`; Postgres-backed rate limits; CSP and security headers; health checks, logs, Sentry and the funnel; the sign-in, paywall, onboarding and account UI.
- **Ops:** CI (typecheck, tests, build, audit, E2E, CodeQL, Dependabot), migrations on deploy with approval, release and rollback docs, the launch plan with invite waves, the incident runbook, the FAQ and launch copy, draft legal pages.
- **What's left is mostly the owner's** (accounts, keys, a domain, a lawyer): see TODO "P0: Launch" and `docs/LAUNCH.md`. **Verified:** `node tools/e2e.mjs` runs the real server against fake providers (`tools/fake-providers.mjs`): 14 API journeys pass (sign in → pay → webhook → connect → build → 409s → portal → export → delete) and the 8 browser journeys passed in QA's run; `tests/fuzz-game.test.ts` proves the server accepts exactly what the browser allows; the load test held 1,200 founders over 2 minutes with 0 errors (p95 under 160 ms except a first timeline build, ~1.3 s). QA's bugs are fixed (a minute of 500s after deleting an account; land opened today couldn't be built on today; a Stripe price-API stampede from `/api/config`).

**Design pass (2026-10-13):** the owner asked for the best possible motion, branding, layout, colour and UI/UX work before launch. Six agents, each in its own files; the brand (mark, palette, fonts) was kept and elevated, not redesigned.

- **The front door** (`src/ui/frontdoor.ts`): a first visit opens on a title card over the grown demo city with a slow camera sway (`Stage.attract`); "Watch a startup grow" brings the HUD in and replays from day 1. Shown once, to signed-out demo visitors, never with preview params; `?intro` forces it.
- **Motion** (`styles.css`, `index.html`, `loader.ts`, `dom.ts`): the boot screen assembles the mark and draws the skyline, then lifts off like a sheet; the HUD follows it in (`revealHud()` / `html.hud-in`); numbers count and tint; toasts, dialogs, drawer and tooltips enter and leave with purpose; reduced motion respected.
- **Paywall and account** (`plans.ts`, `signin.ts`, `onboarding.ts`, `account.ts`, `waitlist.ts`, `hosted.css`): a two-column plan picker with the terms at reading size, six-box codes, a Linear-style account dialog.
- **Brand kit:** `docs/BRAND.md` (the brand book), `public/brand/` (lockups outlined from the real wordmark, avatars, social images rendered from the game), a press page at `/brand/`, `tools/brand-assets.mjs` to regenerate.
- **Email and static pages:** a masthead with the skyline, a ticket-like invite with a picture of the demo city, a digest led by its numbers, legal pages with contents and print styles, a 404 that builds itself.
- **Fog over locked land** (`src/render/fog.ts`): see the fog commit.

**Build wave (2026-10-14):** the owner kept the price in the invite email and said "continue building". Seven agents, each in its own files:

- **The moon trip** (`src/render/moonscene.ts`): a ~30 s cinematic from lift-off to the founder's moon house and back; skippable; `?moon`.
- **Sound** (`src/audio/`): synthesised ambience and event sounds, off by default (speaker button or M).
- **Growth clip** (`src/ui/recap*.ts`): Share → a 15 s square or vertical video of the city growing with the real numbers, filmed frame by frame (WebCodecs → MP4/WebM).
- **Database load:** one `user_state()` call per request (migration 0007); a session is 13 calls instead of 34. Ship 0007 first.
- **Scenery, landmarks, models:** lamp pools at night, the Marina, Golden Gate Park, the airport, the Palace of Fine Arts, City Hall, floodlit landmarks, the island's villa and grounds, over-budget models trimmed. Grown city ~247 draw calls.

Still open with the owner: whether the public GitHub repository should stay public, the legal decisions in LAUNCH.md, and the two account-deletion questions in TODO.

**Headless gotcha learned:** homes build a few per frame; SwiftShader frames are slow, so screenshot tools call `city.finishBuilding()` after scrubbing (`tools/playwright.mjs`), otherwise shots catch a half-built city.

**Built and working:**

- **World** (`src/world/map.ts`, `src/render/scenery.ts`, `landmarks.ts`, `terrain.ts`): the Bay layout described in §3, sculpted terrain, and a water shader with depth, foam and specular.
- **The city** (`src/render/city.ts`) reconciles the scene against the plan each day:
  - homes are batched;
  - items get construction sites (hoarding, crane, scaffolding, dust);
  - HQ levels 0–4;
  - founder homes on the ladder;
  - planes on the apron, yachts at the marina, the rocket on the launch pad;
  - tents and decay.
- **Batching** (`batch.ts`): homes, neighbourhood grounds, plot items, founder homes, planes and yachts share one `Batch` in City; Life and Scenery have their own. `Batch.add` merges the shared buckets and the lit layers (glow, Kit windows, neon, screens, recognised by shader cache key); anything else stays a real object on the model's proxy, which must then be in the scene. Move a proxy, then `touch(key)`; City does this for animations and building sites.
- **Homes** (`buildings.ts`, finished by the homes agent):
  - Sunset "Doelger" stucco, Marina Mediterranean and Edwardian cottages (`house`);
  - painted ladies (`townhouse`);
  - Edwardian, brick and deco flats with fire escapes, corner shops and roof decks (`apartment`);
  - six tree kinds;
  - block grounds with sidewalks, street trees, lamps, mid-block gardens and pocket parks.
- **Downtown and buyables** (`towers.ts`, `models.ts`): towers in several SF styles, a Transamerica-style pyramid, a Salesforce-style spire, every catalogue item, HQ levels, founder homes, planes, yachts, the rocket and the airliner. Finished; leftovers in TODO.
- **Traffic** (`traffic.ts`, 41 draw calls, about 0.7 ms per frame):
  - instanced car models (sedan, hatchback, SUV, pickup, yellow cab, van, Muni bus, sports car, EV);
  - a lane graph with turns and all-way stops;
  - streams across both bridges;
  - pedestrians and joggers;
  - head, tail and brake lights;
  - 49 all-way stops and 5 signalised Market crossings with a green wave;
  - Bay Bridge westbound on the upper deck, eastbound on the lower.
  - Finished; leftovers in TODO.
- **Life** (`life.ts`): ferries (Sausalito, Oakland), a container ship, sailboats, airliners on a keyframed cycle at the airport, cable cars, kites, gulls, Karl the Fog, cloud shadows, and wakes.
- **Effects** (`effects.ts`): rain that follows the camera, F-line streetcar, fireworks (peony, ring, palm, willow).
- **Look** (`post.ts`, `stage.ts`):
  - post pipeline: MSAA, GTAO (ignoring transparent objects), bloom stronger at night, tilt-shift, grade, vignette, grain;
  - environment map on glass only;
  - adaptive quality;
  - darker moonlit nights with deep navy water.
- **UI** (`src/ui/*`, `index.html`):
  - new brand: logo mark (an isometric block with a Golden Gate–orange tower) and the "TinyTown" wordmark;
  - design tokens and Google Fonts;
  - loading screen;
  - HUD: metrics card, city treasury card with satisfaction ring and housing meter, decay alerts;
  - clock chip with a sun arc;
  - timeline dock with MRR chart and milestones;
  - toasts;
  - build menu with real 3D thumbnails (`thumbnails.ts`);
  - home ladder dialog;
  - share card;
  - mobile layout.
  - Finished; leftovers in TODO.
- **Game** (`src/game/*`): pure `simulate()` economy, catalogue, house ladder, regions, demo script, browser saves.
- **Data and server** (`src/data/*`, `server/*`): Stripe subscriptions → daily MRR history, GitHub releases and commits, demo data. A Node server keeps keys server-side, with 60 s caching and static-file safety.
- **Dev tools:** the `showcase.html` asset showcase (`src/dev/*`), `tools/shot.mjs`, `tools/perf.mjs`, and a cloud SessionStart hook (`.claude/`).

**Known issues and loose ends:** all in `docs/TODO.md`, under "Polish and bugs".

---

## 6. How the overhaul was run (a pattern you can reuse)

The lead session owned the world layout, scenery, city wiring, post-processing, life and effects. It ran **four parallel background agents**, each owning **disjoint files** so they never collided:

| Agent | Owned files | Brief (summary) |
|---|---|---|
| Homes and trees | `src/render/buildings.ts` (+ its own keys in `src/dev/sets.ts`) | SF house types, painted ladies, Edwardian flats, trees, block grounds. Under 1,500 tris per home, under 120 per tree. |
| Towers, HQ, items, vehicles | `src/render/towers.ts`, `src/render/models.ts` | SF skyline towers, Transamerica, Salesforce-style spire, every catalogue item, HQ 0–4 with a legible sign, founder homes ("most love"), planes, yachts, rocket, `airliner()`, plot marker, cloud banks, encampment. Towers under 8k tris, items under 5k, vehicles under 3k. |
| Traffic | `src/render/traffic.ts` + the traffic lines in `city.ts` | Car models as InstancedMeshes, a lane graph with turns and stops, bridge streams, pedestrians, night lights. 120 cars + 300 people at 60 fps. |
| UI and branding | `src/ui/*`, `index.html`, `public/*`, `share()` and boot in `main.ts` | Logo and design system, loading screen, HUD, dock, toasts, build menu with 3D thumbnails, home ladder, dialogs, mobile, share image. |

Lessons:

- Give each agent the owner's verbatim brief, the file ownership, the stable API it must keep, triangle budgets, and how to verify visually. Tell it not to commit; the lead commits.
- Agents that edit files reload the shared Vite dev server mid-screenshot. **Take screenshots from a frozen build** (`vite build` + `vite preview` on its own port).
- Long agent runs hit account usage limits. Resume them with `SendMessage` to the same agent and a tight "finish in this order" list.

---

## 7. Ideas raised but not built yet (don't lose these)

- **Flights to other founders' cities**, with postcards, a guestbook and visitors who can look but not touch.
- **A moon scene** at the end of the rocket flight: land, see your moon house, fly back.
- **"While you were away" summary** when the app opens: income, what changed, decay or recovery.
- **Celebrations:** the sign relighting gets a moment and a share prompt; milestone fireworks; a street festival when satisfaction is high and protest signs at City Hall when it's low.
- **Brand import:** sign up with name and URL, pull the logo and brand colour onto HQ.
- **Public world page** (opt-in, metrics hidden by default), a **growth recap video** (15 s clip of the replay), **desktop mode** (small always-on window or wallpaper).
- **PostHog** (active users become people on the streets) and **Supabase** (signups).
- **More big-ticket builds** for big cities ($5k+ MRR): a second bridge, a new district across the bay, an international airport, launching your own ventures.
- **More regions, then more cities and themes** (Miami, Tokyo…), only after the first world is exquisite.
- **Leaderboards** on satisfaction or MRR (opt-in); a public score.
- **Sound design** (ambient city, waves, gulls, construction, fireworks).
- **Cosmetics** later (plane liveries, house paint, seasonal decorations), never anything economic.
