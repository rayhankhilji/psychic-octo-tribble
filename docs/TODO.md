# TinyTown backlog

Prioritised. Work from the top unless the owner asks for something else. When you finish something, tick it off here and update "Current state" in `docs/HANDOFF.md`. Add new findings where they belong.

Every task follows the visual bar in `CLAUDE.md`: screenshot it, day and night, before calling it done.

## P0: Housekeeping

- [ ] **Base branch.** `claude/tender-keller-mnunoy` is the only branch on GitHub. Ask the owner whether to create `main` from it, so future work can go through PRs.
- [ ] **Refresh README screenshots** (`docs/images/city.png`, `build.png`, `evening.png`, `night.png`, `decay.png`, `island.png`). Some may still show the old Golden Coast look. Use `tools/shot.mjs` from a frozen build. Suggested shots:
  - `city`: `time=13:00`, `--day=end`, with UI
  - `build`: build menu open (press `b`)
  - `evening`: `time=18:45`
  - `night`: `time=22:00`
  - `decay`: day ~105 at night (tents, dark sign, rust)
  - `island`: `&boost=40`, focus the island

## P1: Finish the visual overhaul (leftovers from the parallel agents)

The four agents' work is committed. Items each one reported as unfinished are listed here.

- [ ] **Perf pass on a real GPU.** Measure draw calls and triangles with `tools/perf.mjs` at day 540, `quality=high`. Target a few hundred draw calls. If over budget, batch or instance more: tents, trees in parks, district items.
- [ ] **Bundle size.** The production chunk is over 1 MB. Split out the showcase-only code and lazy-load `ui/thumbnails.ts` and the post-processing passes if that helps first paint.

## P2: Polish and bugs

- [ ] **Cloud banks over locked land** are bright white at night. Tint them with the atmosphere (they should go blue-grey under moonlight), or soften them with the fog colour.
- [ ] Apartments average about 1,530 triangles, just over the 1,500 home budget. Trim them if perf needs it.
- [ ] `buildings.ts` leaves out the south-west street lamp of each block because `city.ts` puts a junction lamp there. If that lamp moves, add it back.
- [ ] The camera auto-framing ease feels slow when jumping across the timeline. Check on a real GPU (in SwiftShader it never converges, which is expected).
- [ ] Check that the house-pick **swap fee** (25% of the house's value, in game money) is wired in the home dialog (see GAME_DESIGN).
- [ ] Accessibility pass: focus order, aria labels on icon buttons, contrast of small text on the light panels.

## P3: Game features designed but not built

All in `docs/GAME_DESIGN.md` and HANDOFF §7.

- [ ] **"While you were away" summary** when the app opens: income since last visit, what was built, decay or recovery, new unlocks.
- [ ] **Celebrations:** a moment and a share prompt when the TINYTOWN sign relights; bigger fireworks on MRR milestones; a street festival at high satisfaction and protest signs at City Hall at low satisfaction.
- [ ] **Moon scene:** after the rocket launch, cut to the moon, show the moon house, then the return. The moon sprite during flights (`src/render/moon.ts`) is the current stand-in.
- [ ] **Sound:** ambient city by day and night, waves and gulls, construction, fireworks, UI ticks. Off by default or very quiet, with a mute toggle.
- [ ] **More $1B-a-month projects:** a second bridge, a new district across the bay (Oakland side), an international airport upgrade, "launch a venture" from the venture studio.

## P4: Hosted product (the next big phase)

The order agreed with the owner: the game loop first (done), then hosting.

- [ ] **Accounts and saves:** Supabase auth; move saved actions from localStorage to the server.
- [ ] **Server-authoritative game:** run `simulate()` on the server, validate every purchase there, and keep the browser display-only for money.
- [ ] **Connect with Stripe:** OAuth / Stripe Apps, read-only, no pasted keys. Reject test-mode data for the economy.
- [ ] **PostHog** for monthly active users (the housing population), with a manual entry fallback. **GitHub** as an app/OAuth instead of a token.
- [ ] **Brand import:** sign up with the startup name and URL, pull the logo and brand colour, and show them on HQ's rooftop sign and street plaque.
- [ ] **Billing:** $12/month or $99/year with Stripe Checkout, **no free trial**. Ask the owner about a 14-day money-back guarantee. The paywall goes before connecting real data; the demo stays free to view.
- [ ] **Deploy:** Vercel (front end + API routes) + Supabase. Don't buy a domain without asking.

## P5: Social and growth

- [ ] **Public world page** (opt-in, metrics hidden by default) with a shareable URL.
- [ ] **Flights and visits:** buy a plane, pick a founder, play a cinematic flight (taxi, take off, 5–10 s over the ocean, land), then explore their city as a visitor and leave a postcard.
- [ ] **Growth recap video:** export the replay as a 15-second clip.
- [ ] **Leaderboards / public score**, satisfaction first (safer than MRR).

## P6: Later

- [ ] Desktop mode (small always-on window or wallpaper).
- [ ] More regions, then more cities and themes, only once the first world is exquisite.
- [ ] Cosmetics (plane liveries, house paint, seasonal decorations), never economic.

---

## Agent leftovers

From the four agents' final reports at handoff (homes, models, UI, traffic). The homes agent's leftovers are under P2.

### UI and branding (UI agent's report)

Done: design system (Bricolage Grotesque + Geist, sand/ink/Golden Gate orange/Bay blue tokens, automatic night theme), logo mark, favicon, OG image, boot screen, HUD, clock arc, dock chart, toasts, build drawer and bottom sheet with 3D thumbnails, home ladder, connect/share dialogs, postcard share image, mobile layout.

- [ ] **Watch the motion in a real browser.** Headless SwiftShader never runs CSS transitions, so these have never been seen live: count-up numbers, toast and drawer entrances, the boot-screen build-up.
- [ ] Night share-card screenshot after the resolution fix (the step timed out). The share card also always uses day colours; consider a night variant.
- [ ] Thumbnails take seconds each in SwiftShader. Measure on a real GPU, and dispose the second WebGL context (`ui/thumbnails.ts`) after prewarming.
- [ ] Left rail on short screens (< ~800px tall): it scrolls with no visible hint when the city card and both alerts overflow.
- [ ] Speed control cycles 1× → 3× → ½× through one button. A segmented control would need `onSpeed(index)` in `main.ts`.
- [ ] Accessibility of the 3D canvas: plot picking is mouse/touch only, with no keyboard or screen-reader path.
- [ ] The connect dialog shows "TinyTown Pro · $12/month or $99/year". This matches the owner's pricing, but there's no billing behind it yet (P4).

### Towers, HQ, items, founder homes, vehicles (models agent's report)

Done: shared `Kit` in `towers.ts` with three extra lit layers (window glass tinted by day and lit at night, neon with chase/blink/shimmer `FX`, LED screens), plus facade, signage and pixel-font helpers. Four seeded tower styles (555 California, Millennium, 181 Fremont, deco), the Transamerica pyramid, the Salesforce-style spire with the transit-centre park, HQ levels 0–4 with a rooftop sign and street plaque, every plot and block item, all nine founder homes, the vehicles and `airliner()`, and cloud bank, plot marker and encampment. Close-ups: `/showcase.html?set=tt-one&what=item:stadium` (also `home:villa`, `plane:jet`, `hq:3`, `airliner`).

- [ ] **Use the shared `airliner()` in `life.ts`.** `life.ts` still builds its own private airliner (around line 298) because it needs strobe and beacon materials. The shared `models.ts` `airliner(seed)` (A320-class, faces +x, five fictional liveries) puts its nav lights in the neon layer instead. Switch over and drive the blinking through the neon `FX`.
- [ ] **Trim over-budget models:**

  | Model | Triangles | Target |
  |---|---|---|
  | Supertall | 11.6k | ~8k |
  | HQ level 2 | 11.8k | ~8k (fewer terrace bushes, leaner wings) |
  | HQ level 4 | 9.0k | ~8k |
  | Amusement park | 9.8k | ~5k |
  | Shops | 5.9k | ~5k |
- [ ] Rocket: stronger Starship grid fins and chines; the stainless reads close to white.
- [ ] Day yacht: flare the hull more (slightly boxy).
- [ ] Concorde: refine the wing planform.
- [ ] Ballpark: soften the dark left-field bleachers.
- [ ] Hacker house and studio: more rooftop detail.
- [ ] Encampment: close-up review (handle with dignity).
- [ ] Check founder homes and block items from the back (`az=225`).

### Traffic and pedestrians (traffic agent's report)

Done:
- **Cars:** nine instanced car models (about 600 tris each, 4 meshes per model) with paint colours in real-world shares. Night head and tail lights, brake lights, headlight cones, body roll and nose-dive.
- **Lane graph:** covers the grid plus Market, the Embarcadero, the bridge approach and the Great Highway. Smooth turns, 49 all-way stops, 5 signalised Market crossings with a green wave, and a gridlock breaker.
- **Bridges:** Golden Gate two lanes each way; Bay Bridge westbound on the upper deck and eastbound on the lower deck.
- **People:** about 360 pedestrians with corner crossings, plus 22 joggers.
- **Testing:** a 15-minute soak test had zero overlaps and zero deadlocks.
- **Cost:** 41 draw calls (42 at night), about 0.7 ms per update. City API: `setRoads`, `setCount` (`plan.traffic × 2.6`, cap 160), `setLuxury`, `setBlocks`, `update`, and an optional `blocked(x, z, r)` hook.
- **Showcase sets:** `cars` (`&only=sedan,taxi`) and `people`.

- [ ] **Bridge ramps:** bridge decks end in fades instead of ramps into the city (the decks float about 2.3 above the approaches). Draw ramps in `landmarks.ts` so bridge traffic joins the grid.
- [ ] **Streetcars vs cars:** cars crossing Market or Powell can pass through an F-line car or cable car. Wire `traffic.blocked` from `Life` (cable cars) and `Train` (F-line).
- [ ] Fading cars still cast a full shadow.
- [ ] Shadow side: the shadow offset (0.03) is bigger than car ground clearance, so cars now cast shadows from both faces. Check other low objects for missing shadows.
- [ ] Not built yet: pedestrian walk signals, lane changes on the bridges, people on Market's plazas and the piers, umbrellas in rain.
- [ ] Cab (638) and sports car (648) are about 8% over the ~600 triangle budget.
- [ ] Watch the motion on a real GPU (headless frames were too slow to judge it).
