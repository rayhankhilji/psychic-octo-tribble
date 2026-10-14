# TinyTown backlog

Prioritised. Work from the top unless the owner asks for something else. When you finish something, tick it off here and update "Current state" in `docs/HANDOFF.md`. Add new findings where they belong.

Every task follows the visual bar in `CLAUDE.md`: screenshot it, day and night, before calling it done.

## P0: Housekeeping

- [x] **Base branch.** `main` created (2026-10-13, owner's go) from the latest work. The GitHub default branch is still `claude/tender-keller-mnunoy`: the owner can switch it to `main` in the repo's Settings → General.
- [x] **Seeded cities.** Every founder's world comes from their profile's seed: same 34 home blocks, build blocks and HQ, a different coast, Golden Gate, island, Twin Peaks and Hills plan, parks, landmarks, towns and palette. Seed 0 is the classic map, exactly. Tested over 50+ seeds.
- [ ] Seeded leftovers: Market's angle is fixed (only its length varies); no lakes yet; the central park and squares aren't in the showcase; Coit Tower next to the Presidio can read as a lone column; a North Point's beach is wide.

## P0: Launch (the owner is going live to a 10,000-person waitlist)

Built and committed (2026-10-13): accounts, billing, the paywall, onboarding, the account menu, server-checked saves, export and deletion, email, scheduled pipelines, the waitlist and admin console, security, observability, CI/CD, legal pages, and the launch docs. What's left is mostly the owner's: accounts, keys, money, a domain and a lawyer. **Follow `docs/LAUNCH.md`.**

- [ ] **Owner: long-lead items, 14+ days out.** Submit the Stripe App for review (4 business days a round; until it's published only 25 accounts can connect, so no paid wave before then). Activate live Stripe. Buy the domain. Start warming the Resend sending domain.
- [ ] **Owner: accounts and settings** (`docs/SETUP.md`): Supabase Pro (migrations 0001–0006, auth providers, custom SMTP and raised email limits, the six templates), Stripe (`tools/stripe-setup.mjs`, then dashboard settings), the Stripe App, the GitHub App, Resend, Vercel Pro and every env var, Turnstile, Sentry, an uptime monitor, `docs/SECURITY.md` settings, `docs/RELEASE.md` repo settings (default branch `main`, ruleset, environments and secrets).
- [ ] **Owner and lawyer:** fill the placeholders in `public/legal/*.html` and `public/.well-known/security.txt`; decide governing law and the entity; the EU/UK 14-day withdrawal right against "no refunds" (if waived, add the consent text to Checkout); retention periods; US auto-renewal reminders; whether the repository should stay public.
- [ ] **Owner decisions:** void unpaid invoices when a past-due founder deletes their account? Do cancelled cities expire?
- [ ] **First real run in test mode** end to end on a Vercel preview (sign in → pay → connect → build → delete), then wave 0 (about 25 friends) with real money.
- [ ] **Owner: capacity for launch day** (from the load test, `tools/loadtest.mjs`): one founder opening their city and building costs ~13 database calls (was ~36), so the database is the main risk at 10,000 founders. Run Supabase on Small or Medium compute for launch week and watch database CPU. Raise Supabase's auth "Email sent" limit past the wave size. Ask Stripe Support for higher limits only if you expect a sale-sized rush (they want weeks of notice).
- [x] Cut database calls per session: one call per request (`user_state()`, migration 0007, `server/state.ts`); a session (page load + 3 builds) is 11–13 calls instead of 31–34; has-paid is still read on every request. Ship 0007 in its own PR first (the code falls back to separate reads without it). Left: a stale timeline rebuild still reads `metric_snapshots` separately; the waitlist gate in `access.ts` could reuse the plan from `user_state`.
- [ ] Optional: env-overridable provider base URLs (loopback only) so e2e can run without the fetch-rewriting preload (patch in the QA report, kept in `tools/fake-providers.mjs` comments).
- [x] Admins need a second factor: `/api/admin/*` refuses sessions below `aal2` (`mfa_required`), and the console walks an admin through adding an authenticator the first time. `ADMIN_MFA=off` for local testing.
- [x] Email settings in the account menu (weekly digest, product updates).
- [x] Fewer database calls per visit (reads rate-limited in memory; lastSeen written once a day in one call).
- [ ] Known gaps: founders must remove the Stripe App themselves after deleting; per-instance limits on telemetry; `style-src 'unsafe-inline'` (inline `style=` attributes in the HUD). Several cities on one Stripe account is allowed on purpose: co-founders share one company account.

## P1: Design pass follow-ups (2026-10-13)

- [x] **Re-render the launch images after the fog change** (done; rerun after big visual changes): `node tools/brand-assets.mjs social --base=<dev url>` (the social kit) and `node tools/email-assets.mjs` (the invite's city picture) still show the old cloud look.
- [x] **Owner confirmed (2026-10-14):** the invite email keeps the price ("$12 a month or $99 a year"), matching the terms page.
- [ ] **Lawyer:** privacy §2 says no marketing email unless asked, but the weekly digest is on by default; and the legal pages use British spelling while the product uses US.
- [ ] **Front door on phones:** the camera stops at `minZoom` 0.32, so the top half shows downtown cropped; let attract mode zoom out further on portrait screens (check shadows and the far plane).
- [ ] **Mobile help button:** the floating "?" under the mini card is heavy; consider a small icon in the top bar.
- [ ] **A real-device pass** in a GPU browser (pointer hover, the camera drift's smoothness, Turnstile with network) and a Litmus/Email on Acid run for the emails (Outlook on Windows, Gmail dark mode on Android).
- [ ] **Next brand assets:** Stripe App listing images (≥1,600 px, no real customer data), a short golden-hour loop for X and Product Hunt, a zip on the press page.

## P1: The reference-image quality push (in progress)

The owner sent reference images (the Silicon Valley title slide is the art-direction target; GTA's Vinewood Hills for the Hills; SimCity BuildIt and 2013 for tidy blocks) and a screenshot of our bay they hate. Four agents worked on it, each owning its own files. See CONVERSATION_LOG for their words.

- [x] **CPU.** Frames are paced: 60 fps while anything moves, 30 fps once the city has been calm for 4 s; hover raycasts at most every 100 ms and never while dragging.
- [x] **Places menu** (pin button or G): one click to Downtown, the Hills, the Wharf, the Marina, the Airport and your island.
- [x] **Downtown and brand assets.** Two new tower styles, a roof and signage kit, richer plot items and HQ levels, new yacht hulls and plane liveries.
- [x] **Mansion choices.** Three Hills houses and three island estates to choose from. The first pick is free; rebuilding costs 25% of the tier's value in game money.
- [x] **Neighbourhoods.** One street style per block, the same building line on every street, corner homes that turn the corner, richer homes, block grounds with evenly spaced street trees, gardens and corner stores.
- [x] **Helicopter.** It comes with the island, parks on the airport helipad, and flies you to your estate's pad (and back) from Your home, with the camera following (`City.flyHelicopter`, `Stage.follow`).
- [x] **Landscape.** The Hills as a real neighbourhood on contour streets that come down to the grid; Twin Peaks with two summits; Yerba Buena a clean dome; real backdrop towns instead of stripes; the airport on fill with a lit runway, terminal and helipad; a bigger island with a cove, jetty, beach and lighthouse; Treasure Island rebuilt.
- [ ] Landscape leftovers: parks, waterfront and Marina polish; Hills street lamps have no light pools at night; backdrop town windows barely show at night; the island's cove and jetty face away from the default camera; check the Hills from `az=225`.
- [x] **Bay.** The Bay Bridge is one continuous structure from Rincon Point through Yerba Buena to Oakland; the Golden Gate has its viaduct, toll plaza and Waldo Tunnel; marquee bulbs on the TINYTOWN sign come on at dusk; new ferry, container ship, sloops, tugs and wakes; landmarks in detail.
- [ ] Bay leftovers: from the default view the Waldo Tunnel hood reads as a box (its rainbow mouth only shows from the south and west); the Oakland landing is simple; one tree still stands in front of the Cliff House.
- [x] **Over-budget plot items** trimmed to budget with no visible change (stadium 7.9k → 4.9k, university 6.4k → 4.9k, amusement park 6.1k → 4.9k, supertall 8.5k → 7.9k, corner shops 5.4k → 5.0k); shared helpers (`post`, `ball`, `tube`, lighter people, sills and the founder's car) cut ~10.8k across every item and home. Follow-ups: the amusement park's paving is empty; the university's Palm Drive crowns overlap the south range's roof.
- [x] The launch site moved south-east of the estate, so the rocket no longer hides the estate's helipad from the default camera (a map test keeps it off the camera side). The founder's Hills driveway now joins the house pad.

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
- [x] Apartments measure 1,195 triangles on average over real seeds (max 1,610), under the home budget.
- [ ] `buildings.ts` leaves out the south-west street lamp of each block because `city.ts` puts a junction lamp there. If that lamp moves, add it back.
- [ ] The camera auto-framing ease feels slow when jumping across the timeline. Check on a real GPU (in SwiftShader it never converges, which is expected).
- [x] Check that the house-pick **swap fee** (25% of the house's value, in game money) is wired in the home dialog (see GAME_DESIGN). (first pick free, then 25% renovation with a confirm step)
- [x] Accessibility pass: focus order, aria labels on icon buttons, contrast of small text on the light panels. (AA tokens day and night, modals trap and return focus, labels, live regions)

## P3: Game features designed but not built

All in `docs/GAME_DESIGN.md` and HANDOFF §7.

- [x] **"While you were away" summary** when the app opens. Logic done and tested (`src/game/away.ts`, `lastSeen`/`markSeen` in `save.ts`); the card (`Hud.showAway`) is being built by the UI agent, then main.ts wires it at boot with a `?away=N` preview param for the demo. Done: card is `Hud.showAway`; try `/?demo&away=30`.
- [x] **Celebrations, part 1:** fireworks shows over the bay for MRR milestones (smaller downtown for customer milestones); a street festival on Civic Center Plaza at satisfaction 85+, an orderly protest at City Hall below 40 with a banner naming the weakest part.
- [x] **Celebrations, part 2:** when the TINYTOWN sign relights on the live day, the camera flies to the hillside for the fireworks and the feed offers "Share this" (a postcard). Feed toasts can carry an action button.
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
- [x] **Growth recap video:** Share → Growth clip: 15 s, square or vertical MP4/WebM, filmed frame by frame with a branded overlay and the real numbers (`src/ui/recap.ts`). Left: one run in real Chrome and Safari to confirm the MP4/H.264 path and Share on a phone; a 15 s square clip is ~10–15 MB (`bitrateFor()`).
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
