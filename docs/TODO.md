# TinyTown backlog

Prioritised. Work from the top unless the owner asks for something else. When you finish something, tick it off here and update "Current state" in `docs/HANDOFF.md`. Add new findings where they belong.

Every task follows the visual bar in `CLAUDE.md`: screenshot it, day and night, before calling it done.

## P0: Housekeeping

- [ ] **Base branch.** There's no `main`: work lives on `claude/*` branches. The owner opened PR #1 (`claude/friendly-darwin-sjkcz1` → `claude/tender-keller-mnunoy`). Still worth creating `main` so CI's `push: [main]` trigger means something; ask before creating it.
- [ ] **Seeded cities (asked the owner, awaiting "go").** The owner wants every founder's city to be different: same size, same number of plots, different layout and structure. Proposal: keep a recognisable sunny bay city, but seed the coastline shape, hill and park placement, which neighbourhoods and landmarks you get and where, house styles, palettes and tree mix; the plot count and unlock gates stay fixed for fairness; the demo keeps today's layout as one seed. Touches `world/map.ts` (pure, testable) first.

## P1: The reference-image quality push (in progress)

The owner sent reference images (the Silicon Valley title slide is the art-direction target; GTA's Vinewood Hills for the Hills; SimCity BuildIt and 2013 for tidy blocks) and a screenshot of our bay they hate. Four agents worked on it, each owning its own files. See CONVERSATION_LOG for their words.

- [x] **CPU.** Frames are paced: 60 fps while anything moves, 30 fps once the city has been calm for 4 s; hover raycasts at most every 100 ms and never while dragging.
- [x] **Places menu** (pin button or G): one click to Downtown, the Hills, the Wharf, the Marina, the Airport and your island.
- [x] **Downtown and brand assets.** Two new tower styles, a roof and signage kit, richer plot items and HQ levels, new yacht hulls and plane liveries.
- [x] **Mansion choices.** Three Hills houses and three island estates to choose from. The first pick is free; rebuilding costs 25% of the tier's value in game money.
- [x] **Neighbourhoods.** One street style per block, the same building line on every street, corner homes that turn the corner, richer homes, block grounds with evenly spaced street trees, gardens and corner stores.
- [ ] **Helicopter** (written, waiting on the landscape commit for `HELIPAD`). It comes with the island, parks on the airport helipad, and flies you to your estate's pad from the home dialog, with the camera following.
- [ ] **Landscape** (agent running): the Hills as a real neighbourhood on contour streets that connect to the city; terrain without the odd humps; the island further out and bigger; an airport you can see.
- [ ] **Bay** (agent running): a whole, grounded Bay Bridge; Yerba Buena and Treasure Island; better boats; bulbs on the TINYTOWN sign that light up at night.
- [ ] **Over-budget plot items** (low priority: each is a one-off, so the cost is a few thousand triangles in all): the stadium (7.9k triangles), the university (6.4k) and the amusement park (6.1k), against a ~5k budget for plot items. The supertall (8.5k) is near the 8k tower budget.
- [ ] The rocket on the launch site stands right in front of the estate's helipad from the default camera. Move one of them.

## P1: Finish the visual overhaul (leftovers from the parallel agents)

The four agents' work is committed. Items each one reported as unfinished are listed here.

- [x] **Perf pass: draw calls.** 742 → **263** draw calls (day 540, `quality=high`, shadow pass included). `Batch` now merges any GeoBuilder/Kit model (lit layers too) and keeps unmergeable parts on the proxy; grounds, items, founder homes, planes, yachts, Life's boats and airliners, and static scenery are batched; Ferris gondolas and sea lions instanced. `tools/perf.mjs` lists the objects that cost the most calls.
- [x] **Lag (CPU).** The replay was rebuilding ~5,400 homes for a city of ~350 (planWorld broke "growth only adds"); fixed and tested. Homes, grounds, tents and meadows build from a frame-budgeted queue (4 ms per replay frame, 40 ms after a jump). Replay JS 30 s → under 8 s here; worst frame 1.4 s → ~0.13 s.
- [x] **Lag (GPU).** Half-res GTAO, pixel ratio 1.5/1.25/1, MSAA 4/2/0, shadows 4096/2048/1536 by quality; adaptive quality aims for ~50 fps all session and steps back up.
- [ ] **Perf, what's left.** Confirm frame time on a real GPU (no GPU in the container). "Other" per-day JS is HUD/GameUI DOM work (~10 ms p95 here); profile it on a laptop. Traffic is now the biggest single cost (73 calls: 9 models × 4 meshes + shadows); HQ is 19. Triangles are ~2.2M *including* the shadow pass (about 1.1M per pass); trimming the over-budget models helps. 107 shader programs (mostly post passes and per-key variants): check compile time on a real GPU. Then confirm frame time on a real GPU and tune adaptive quality (`stage.ts` `adapt()`).
- [x] **Bundle size.** three.js is its own chunk (170 kB gzip, cached across our releases); the app chunk is 163 kB gzip. The boot screen paints from `index.html` before any JS, so lazy-loading thumbnails or post passes wouldn't change first paint much.

## P2: Polish and bugs

- [x] **Rocket missing in the boosted demo.** The boosted demo crosses $1M MRR on day 537, not 536; fixed and tested. (The README `island.png` still lacks it: refresh it.)
- [x] **Cloud banks over locked land** go moonlit blue-grey at night (`cloudMaterial`/`setCloudLight` in `models.ts`, called from `city.ts`).
- [x] **Lighthouse beam** was built backwards as a flat wedge and shone through the island's clouds; now a soft beam, only once the island is yours.
- [x] **Scenery tooltips** (City Hall, Market Street, the Wharf…) were never raycast; fixed.
- [x] **Kites made the shared smooth material double-sided** for every model; fixed.
- [x] **Night blow-outs:** Ferry Building nave and clocks, glass flatirons on Market.
- [x] **Suburbs** read as a field of dots from above; Daly City is now terraced rows on streets over the hills, with muted roofs. The East Bay hills houses are still scattered: give them the same treatment.
- [x] **TinyTown Hills redesign** (owner: "really not great quality"): Twin Peaks Boulevard with curbs, walls, lamps and palms; terraced lots; chaparral on golden hills; a family of four house styles in `render/hills.ts`.
- [x] **Treasure Island** (Building One, hangars, streets, Clipper Cove), the **Bay Bridge east span** (twin decks, four-legged tower, suspension cables), **Oakland** towers, **Daly City and the East Bay** as terraced streets.
- [ ] Next visual targets the owner will notice: the airport, the Marina and Palace of Fine Arts close up, Golden Gate Park detail, the founder's island estate, and the TINYTOWN sign's hillside.
- [ ] Apartments average about 1,530 triangles, just over the 1,500 home budget. Trim them if perf needs it.
- [ ] `buildings.ts` leaves out the south-west street lamp of each block because `city.ts` puts a junction lamp there. If that lamp moves, add it back.
- [ ] The camera auto-framing ease feels slow when jumping across the timeline. Check on a real GPU (in SwiftShader it never converges, which is expected).
- [x] Check that the house-pick **swap fee** (25% of the house's value, in game money) is wired in the home dialog (see GAME_DESIGN). (first pick free, then 25% renovation with a confirm step)
- [x] Accessibility pass: focus order, aria labels on icon buttons, contrast of small text on the light panels. (AA tokens day and night, modals trap and return focus, labels, live regions)

## P3: Game features designed but not built

All in `docs/GAME_DESIGN.md` and HANDOFF §7.

- [x] **"While you were away" summary** when the app opens. Logic done and tested (`src/game/away.ts`, `lastSeen`/`markSeen` in `save.ts`); the card (`Hud.showAway`) is being built by the UI agent, then main.ts wires it at boot with a `?away=N` preview param for the demo. Done: card is `Hud.showAway`; try `/?demo&away=30`.
- [x] **Celebrations, part 1:** fireworks shows over the bay for MRR milestones (smaller downtown for customer milestones); a street festival on Civic Center Plaza at satisfaction 85+, an orderly protest at City Hall below 40 with a banner naming the weakest part.
- [ ] **Celebrations, part 2:** a moment and a share prompt when the TINYTOWN sign relights.
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
- [x] Night share-card screenshot after the resolution fix (the step timed out). The share card also always uses day colours; consider a night variant. (postcard follows the day/night theme: `ui/postcard.ts`)
- [x] Thumbnails take seconds each in SwiftShader. Measure on a real GPU, and dispose the second WebGL context (`ui/thumbnails.ts`) after prewarming. (lazy studio, toBlob, one context, idle-paced; still measure on a real GPU)
- [x] Left rail on short screens (< ~800px tall): it scrolls with no visible hint when the city card and both alerts overflow.
- [ ] Speed control cycles 1× → 3× → ½× through one button. A segmented control would need `onSpeed(index)` in `main.ts`.
- [ ] Accessibility of the 3D canvas: plot picking is mouse/touch only, with no keyboard or screen-reader path.
- [ ] The connect dialog shows "TinyTown Pro · $12/month or $99/year". This matches the owner's pricing, but there's no billing behind it yet (P4).

### Towers, HQ, items, founder homes, vehicles (models agent's report)

Done: shared `Kit` in `towers.ts` with three extra lit layers (window glass tinted by day and lit at night, neon with chase/blink/shimmer `FX`, LED screens), plus facade, signage and pixel-font helpers. Four seeded tower styles (555 California, Millennium, 181 Fremont, deco), the Transamerica pyramid, the Salesforce-style spire with the transit-centre park, HQ levels 0–4 with a rooftop sign and street plaque, every plot and block item, all nine founder homes, the vehicles and `airliner()`, and cloud bank, plot marker and encampment. Close-ups: `/showcase.html?set=tt-one&what=item:stadium` (also `home:villa`, `plane:jet`, `hq:3`, `airliner`).

- [ ] **Use the shared `airliner()` in `life.ts`.** `life.ts` still builds its own private airliner (around line 298) because it needs strobe and beacon materials. The shared `models.ts` `airliner(seed)` (A320-class, faces +x, five fictional liveries) puts its nav lights in the neon layer instead. Switch over and drive the blinking through the neon `FX`.
- [x] **Trim over-budget models** (supertall 8.2k, HQ2 6.5k, HQ4 8.0k, amusement park 5.4k, shops 5.0k; pyramid 5.6k and university 6.2k still a bit over):

  | Model | Triangles | Target |
  |---|---|---|
  | Supertall | 11.6k | ~8k |
  | HQ level 2 | 11.8k | ~8k (fewer terrace bushes, leaner wings) |
  | HQ level 4 | 9.0k | ~8k |
  | Amusement park | 9.8k | ~5k |
  | Shops | 5.9k | ~5k |
- [x] Rocket: stronger Starship grid fins and chines; the stainless reads close to white.
- [x] Day yacht: flare the hull more (slightly boxy).
- [x] Concorde: refine the wing planform.
- [x] Ballpark: soften the dark left-field bleachers.
- [x] Hacker house and studio: more rooftop detail.
- [x] Encampment: close-up review (handle with dignity).
- [x] Check founder homes and block items from the back (`az=225`).

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
- [x] **Streetcars vs cars:** cars wait at junctions for running F-line streetcars and cable cars (soak-tested, no gridlock).
- [x] Fading cars still cast a full shadow (dithered depth material for cars and pedestrians).
- [ ] Shadow side: the shadow offset (0.03) is bigger than car ground clearance, so cars now cast shadows from both faces. Check other low objects for missing shadows.
- [ ] Not built yet: pedestrian walk signals, lane changes on the bridges, people on Market's plazas and the piers, umbrellas in rain.
- [ ] Cab (638) and sports car (648) are about 8% over the ~600 triangle budget.
- [ ] Watch the motion on a real GPU (headless frames were too slow to judge it).
