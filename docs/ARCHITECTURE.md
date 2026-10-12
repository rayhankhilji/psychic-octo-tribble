# TinyTown architecture

How the code is organised, how data becomes a city, and the conventions and gotchas that matter when you change it.

## Data flow

```
Stripe / GitHub ──► server/            fetch + 60 s cache, keys stay here (Node ≥ 22.18, plain fetch)
                     │  /api/timeline
                     ▼
              src/data/                 Stripe subs, GitHub → one Snapshot per day (pure)
                     │                  demo.ts: the fictional "Nightjar" startup (540 days)
                     ▼
              src/world/                Snapshot → WorldPlan (pure, deterministic, seeded by name)
                     │                  two days → WorldEvents (customers, releases, rain…)
                     ▼
              src/game/                 simulate(snapshots, actions, upto) → GameState
                     │                  treasury, upkeep, housing, satisfaction, plots, regions, house ladder
                     ▼
              src/render/               three.js: City reconciles the scene against (plan, game state)
              src/ui/                   HUD, game UI, build menu, dialogs, timeline, toasts, share
                     ▲
              src/main.ts               App: wires data → plan → game → City/Stage/HUD, the replay clock
```

Everything above `src/render` is **pure and unit-tested** (`tests/`). The same numbers always produce the same city. Growth only adds, so customer #12's house never moves when #13 arrives.

## Source map

| Path | What it is |
|---|---|
| `src/main.ts` | The `App`: loads live data (`/api/timeline`) or the demo, runs the replay/timeline, applies saved actions, connects HUD/GameUI handlers to the City and Stage, and builds the share image. Reads URL params (below). |
| `src/data/` | `types.ts` (Snapshot = one day of metrics), `stripe.ts` (subscriptions → MRR history), `github.ts`, `merge.ts`, `demo.ts`. |
| `src/world/map.ts` | **The Bay geometry.** No rendering. Coastline polygons (MAINLAND, MARIN, EAST_BAY), ISLANDS, hills (Twin Peaks, Sutro, Telegraph…), `terrainHeight(x,z)`, the block lattice and each block's use (`hq`, `city`, `market`, `park`, `presidio`, `hill`, `civic`), Market Street, arterial polylines (EMBARCADERO, GREAT_HIGHWAY, PRESIDIO_PKWY, BAY_APPROACH, AIRPORT_ROAD), `LANDMARKS`, site coordinates (pier, marina, airport, launch). |
| `src/world/layout.ts` | Which blocks are districts or neighbourhoods, lots per block (12 edge lots, 10 homes, 2 corner tree lots), home kinds by density, `planWorld()`. |
| `src/world/daylight.ts` | `atmosphereAt(hour, wet)`: keyframed sun, sky, fog, exposure and bloom, plus `night` 0–1. Follows the local clock. |
| `src/world/events.ts`, `history.ts` | Day-to-day events (with copy that quotes the real number) and rain rules. |
| `src/game/catalog.ts` | Every buyable item (price, upkeep, unlock MRR, placement, model key), `HOME_TIERS` (house ladder), `BUILD_BLOCKS`, `REGIONS`, sites. |
| `src/game/economy.ts` | `simulate()`: RATE 10,000, starting grant, FREE_HOUSED 100, MRR_PER_USER 0.2, upkeep, decay stages, satisfaction. |
| `src/game/save.ts`, `demo-script.ts` | localStorage actions; what the demo founder builds (gated on unlocks). |
| `src/render/stage.ts` | Renderer, orthographic iso camera (`VIEW=26`, `DISTANCE=240`, polar `acos(1/√3)`), OrbitControls (drag pan, right-drag or Q/E rotate in 90° steps, zoom), auto-framing, adaptive quality, picking/tooltips, the frame loop, `capture()`. Exposes `window.__stage` in dev. |
| `src/render/post.ts` | Post pipeline: `EffectComposer` (HalfFloat, MSAA ×4) → `SolidAO` (GTAO that hides sprites and transparent objects) → `UnrealBloom` (strength `bloom·(0.2+0.8·night)`) → `OutputPass` → `GradeShader` (tilt-shift golden-spiral blur, grade, vignette, grain). |
| `src/render/city.ts` | **`City`**: owns the scene, lights (sun with shadow camera following the view, hemi, warm night fill), sky/fog per hour, and reconciles everything metric-driven: homes (via `Batch`), districts and items (with `Construction` sites), HQ, founder homes, vehicles on sites, tents and decay, highlights for placement. Calls `update()` on traffic, life, scenery, rain, fireworks, train and moon. |
| `src/render/scenery.ts` | Everything metrics don't drive: terrain and water, roads, Market Street plazas and flatirons, parks, the waterfront and piers, marina, airport, island, suburbs, the sign, bridge lights. |
| `src/render/landmarks.ts` | Golden Gate, Bay Bridge, Ferry Building, Coit Tower, Palace of Fine Arts, Sutro Tower, windmill, City Hall, the TINYTOWN sign. |
| `src/render/terrain.ts` | One sculpted terrain mesh (vertex colours: beach, grass, chaparral, rock) and the water `ShaderMaterial` (depth texture, waves, fresnel, specular, surf). |
| `src/render/buildings.ts` | Homes (`home(kind, seed)`), trees (`tree`, `palm`, kinds round/cypress/plane/ficus/eucalyptus), `neighbourhoodGrounds()`. |
| `src/render/towers.ts` | Downtown: `tower`, `pyramid`, `spire`, `deco`, `campus`, `headquarters(name, floors, seed, level)` with sign and beacon. |
| `src/render/models.ts` | `itemModel(model, x, z, seed)` for every catalogue item, `founderHome`, `plane`, `airliner`, `yacht`, `rocket`, `cloudBank`, `plotMarker`, `encampment`. |
| `src/render/traffic.ts` | `Traffic`: lane graph from `roadNetwork(STREET_BLOCKS)` plus arterials, instanced car models, bridge streams, pedestrians. API: `setRoads`, `setCount`, `setLuxury`, `update`. |
| `src/render/life.ts` | `Life`: ferries, container ship, sailboats, airliners, cable cars, kites, gulls, fog, cloud shadows, wakes. |
| `src/render/effects.ts` | `Rain`, `Train` (the F-line), `Fireworks`, `densify`. |
| `src/render/batch.ts` | `Batch`: draws hundreds of GeoBuilder models as one `BatchedMesh` per material, with per-model transform, glow level and tooltip. |
| `src/render/construction.ts` | Building-site animation around a new building. |
| `src/render/moon.ts` | Screen-pinned moon shown during rocket flights (with the moon house at tier 6). |
| `src/render/geo.ts` | **`GeoBuilder`** and the shared materials (see below). |
| `src/render/palette.ts` | Colour palette. |
| `src/ui/` | `hud.ts` (top bar, metrics, timeline dock, feed/toasts, tooltips, dialogs), `game-ui.ts` (city card, build menu, home ladder, placement), `brand.ts` (logo geometry → SVG and canvas), `icons.ts` (one stroke icon family), `dom.ts` (helpers, count-up numbers), `loader.ts` (boot screen), `thumbnails.ts` (offscreen renderer for item thumbnails), `styles.css` (design tokens and all styles). |
| `src/dev/` | `showcase.html` + `showcase.ts` + `sets.ts`: a dev-only grid of models under game lighting. Not in the production build. |
| `server/` | `index.ts` (HTTP + static), `sources.ts` (Stripe, GitHub), `timeline.ts`, `static.ts` (path-safe static serving). |
| `tools/` | Headless screenshot and perf scripts (see DEV_WORKFLOW). |

## World coordinates (memorise these)

- **Compass:** +x = east, +z = north. The camera sits in the **north-east looking south-west**, so by default you see the +x and +z faces of things. The camera rotates in 90° steps, so all four faces must look finished.
- **Lattice:** block `(bx, bz)` is centred at `(bx·5, bz·5)` (`PITCH = 5`). A block is 4×4 lots (`BLOCK = 4`) and streets are 1 unit wide on the lines `x = 2.5 + 5k`, `z = 2.5 + 5k`. HQ is block (0,0).
- **Market Street** runs on the diagonal `x − z = 10`, from the Ferry Building (`[10.6, 0.6]`) to Civic Center (`[-13.5, -23.5]`); City Hall is on the civic block `(-3, -4)`.
- **Landmarks:**
  - Golden Gate: `x = −34.6`, `z 10.2..21.2`, deck y ≈ 2.25.
  - Bay Bridge: `z = −6.5`, `x 11.6..56`, deck y ≈ 2.35.
  - Twin Peaks: `(−14, −36)`, with the sign on its NE slope.
  - Founder island: `(−6, 24.5)`; launch site: `(−1.6, 27.6)`.
- **Ground height:** `terrainHeight(x, z)` (aliased `hillHeight` in scenery). Anything placed off the flat city grid must sit on it (`Math.max(0, h)` over water). Sea level is 0.
- **Scale:**
  - a lot is 1×1, a storey about 0.22–0.26;
  - a car is about 0.34 long, a person about 0.06 tall;
  - planes are 1–2.4 long, yachts 1.2–2.6.

## Building models: GeoBuilder

Every building is built in local space with `GeoBuilder` (`src/render/geo.ts`) and merged into **at most four meshes, one per material bucket**:

| Bucket | Material | Use for |
|---|---|---|
| `solid` | flat-shaded matte `MeshStandardMaterial` | walls, roofs, most things |
| `glass` | flat, glossy, metallic; the only bucket with a strong env map | curtain walls, windows by day |
| `smooth` | smooth-shaded | rounded and lathed parts (rbox, lathe, blob) |
| glow | `glowMaterial()` (MeshBasic + `onBeforeCompile`) | windows at night, lamps, neon, signs |

Primitives:
- `box`, `rbox` (rounded), `lathe`, `gable`, `hip`, `cylinder`, `blob`;
- `quad` (axis-facing) and `panel` (any rotation), glowing by default;
- `decal`, `transformed` (any BufferGeometry + matrix);
- `windows(...)`: window grids that read as glass by day and light up at night with some left dark.

Colours are hex or linear RGB triples; values above 1 glow under bloom. `build()` returns `{ group, glow }`.

**Glow:** shared uniforms `GLOW.night`, `GLOW.time` and `GLOW.day`. A per-vertex `winRand` attribute staggers which windows light first at dusk and adds flicker. (It was renamed from `rand`, which clashed with a GLSL built-in name; the shader cache key is `tinytown-glow-3`.)

**Environment map:** `setEnvironment(tex, k)` applies it only to glass (1.25·k) and smooth (0.18·k). **Don't use `scene.environment`**: it overrides per-material intensity and washes everything out.

**Homes go through `Batch`** (`BatchedMesh` per bucket). Home models must therefore use only the standard GeoBuilder materials and add no extra child objects (lights, sprites). BatchedMesh needs `frustumCulled = false` and `perObjectFrustumCulled = true`, because the whole-batch bounding sphere goes stale as homes come and go.

## Budgets

| Thing | Triangles |
|---|---|
| Home (about 350 at once) | ≤ ~1,500 (measured average about 1,280) |
| Tree or palm (thousands) | ≤ ~120 |
| Tower | ≤ ~8k |
| Plot item | ≤ ~5k |
| Vehicle (plane, yacht) | ≤ ~3k |
| Car model (instanced) | ≤ ~600 |

- **Draw calls:** a grown city should stay at a few hundred. Batching cut it from about 1,080 to about 376, but the newest models brought it back up to 755 (see TODO P1). Re-measure with `tools/perf.mjs`.
- **Per frame:** update instance matrices only, with no per-frame allocations in hot loops.

## Rendering gotchas (learned the hard way)

- **GTAO and transparency.** GTAO's normal pre-pass draws everything opaque, so sprites (fog) and transparent effects became dark slabs. `SolidAO` hides them during the AO pass. Keep new transparent effects `transparent: true` so they're skipped.
- **Camera near plane.** The camera sits at `DISTANCE = 240` with `near = 1`; a near plane at or below 0 broke depth for AO.
- **Cloud shadows** are invisible casters on layer 1 (`SHADOW_ONLY_LAYER`; the shadow camera enables layer 1). They only show when the sun is high (elevation > 0.72, night < 0.2), because under a low sun they stretch absurdly.
- **Shadow camera** follows the view and snaps to whole texels so shadows don't crawl; its span scales with zoom.
- **Bloom** is barely on by day (glints only) and stronger at night. Its threshold rises in daylight.
- **Things off the grid** (island estate, rocket, train, roads on hills) must use `terrainHeight`, or they end up buried or floating.
- **Time of day** snaps to the requested hour on the first frame, then eases forward along the clock.
- **The moon** only appears during rocket flights. An always-on moon pinned to the screen hung over the hills: the iso view has no sky.

## UI architecture

- Plain TypeScript + DOM, no framework. `Hud` and `GameUI` expose handler interfaces that `main.ts` implements.
- Design tokens (colours, radii, shadows, motion, spacing) are CSS custom properties at the top of `src/ui/styles.css`. Fonts load from Google Fonts in `index.html`. Numbers use tabular numerals.
- The boot screen lives in `index.html`, so it paints before JS runs; `loader.ts` lifts it after the first frames render.
- Thumbnails: one small offscreen WebGL renderer renders each model once, from the city's iso angle, then caches it as a data URL.
- It must work at 390×844 (mobile, with bottom sheets), 1440×900 and 1920×1080. Respect `prefers-reduced-motion`. Esc closes dialogs; focus rings stay visible.

## Server

- `npm start` serves `dist/` and `/api/timeline` on :8787.
- Env vars (`.env.example`): `TINYTOWN_NAME`, `STRIPE_SECRET_KEY` (restricted, read-only Subscriptions), `GITHUB_REPO`, `GITHUB_TOKEN` (private repos only).
- No dependencies beyond Node ≥ 22.18, which runs TypeScript natively.
- Static serving refuses path traversal; this is tested.
