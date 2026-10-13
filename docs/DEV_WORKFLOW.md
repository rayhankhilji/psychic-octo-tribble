# Working on TinyTown

How to run it, test it, and see what you're doing, especially in a headless **Claude Code cloud container**, where there's no screen and no GPU.

## Setup

A cloud session runs `.claude/hooks/session-start.sh` on start, which runs `npm install`. Locally, or if that didn't happen:

```bash
npm install
```

You need Node ≥ 22.18. Cloud containers ship Chromium for Playwright (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`) and a global Playwright at `/opt/node22/lib/node_modules/playwright`. **Never run `playwright install`** there.

## Everyday commands

```bash
npm run dev          # Vite dev server, http://localhost:5173
npm run typecheck    # tsc --noEmit: must be clean (there's no separate linter)
npm test             # vitest: economy, layout, map, events, daylight, integrations, server
npm run build        # typecheck + production build to dist/
npm start            # serve dist/ + /api on :8787 (needs a build; reads .env)
npm run dev:server   # API server with --watch; run beside `npm run dev` for live data
```

To keep a dev server running in the background in a cloud session:
`npx vite --port 5199 --host` (with Bash `run_in_background`), then use `http://localhost:5199`.

## URLs and parameters

### The game: `/`

| Param | Effect |
|---|---|
| `?demo` | Force the demo world (the fictional *Nightjar*, 540 days). It's the default when no integrations are configured. |
| `&fresh` | Reset saved actions to the scripted demo founder. |
| `&boost=40` | Multiply demo metrics (see the island, launch site and the $1B projects). |
| `&replay` | Start the replay from day one. |
| `&time=13:00` (or `7pm`, `22:00`) | Pin the time of day. Otherwise it follows the local clock. |
| `&quality=low\|medium\|high` | Force render quality (high enables GTAO). |
| `&seed=N` | Show world seed N (0, the classic map, by default). |
| `&mockapi=<state>` | Dev builds only (`vite dev`, or `vite build --mode mockapi`): fake the hosted API. States: `signedout`, `waitlist`, `unpaid`, `canceled`, `paid-unconnected`, `paid-stripe`, `paid-github`, `connected`, `pastdue`, `local`. Extras: `&mockerr=checkout\|portal\|signin\|repos\|users\|connect\|timeline\|link\|delete`, `&mockreject` (next build refused), `&mockcaptcha`; the email code `123456` works. Admin console: `/admin.html?mock&debug`. To screenshot dialogs in SwiftShader, freeze the scene first (`__stage.renderer.setAnimationLoop(null)`) and click through the DOM. |
| `&view=x,z,zoom` | Pin the camera target and zoom (disables auto-framing). Full-city overview: `view=-11.5,-9.2,0.46`. |

### Keys

- Drag to pan; right-drag or <kbd>Q</kbd>/<kbd>E</kbd> to rotate; scroll or <kbd>+</kbd>/<kbd>−</kbd> to zoom.
- <kbd>B</kbd> opens build, <kbd>H</kbd> your home, <kbd>?</kbd> help, <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> step days (<kbd>Shift</kbd> for a week), <kbd>Esc</kbd> closes.

### The asset showcase (dev only): `/showcase.html`

A grid of models under the game's lighting and post-processing. Params:

| Param | Meaning |
|---|---|
| `set` | Which set of models to show. |
| `time` | Hour of the day. |
| `zoom` | Magnification. |
| `az` | Camera azimuth in degrees; `225` shows the back. |
| `cols` | Grid width. |
| `quality` | Render quality. |
| `dbg` | Debug view. |

Sets live in `src/dev/sets.ts`:

| Area | Sets |
|---|---|
| Homes and grounds | `homes`, `house`, `townhouse`, `apartment`, `street` (four full blocks at real lot rotations), `trees`, `grounds` |
| Downtown, items and vehicles | `towers`, `items`, `founder`, `vehicles`, plus the `tt-*` sets: `tt-skyline`, `tt-landmarks`, `tt-hq`, `tt-business`, `tt-civic`, `tt-blocks`, `tt-homes`, `tt-museum`, `tt-vehicles`, `tt-state`, `tt-one` |
| Neighbourhood families | `nb-streets` (every family as a whole block), `nb-one&family=queen&n=1&at=1.2,1.2&zoom=9`, `nb-homes` (mid-row, corner and park-side homes), `nb-trees` |
| The bay and the hills | `bay-boats`, `bay-ship`, `bay-wakes` (boats circling with their wakes), `bay-landmarks`, `ls-flora` (the hills' trees and rocks) |
| Downtown pass | `dt-towers` (`&tier=5`), `dt-tower&style=4&tier=5`, `dt-items&list=shops,cafe`, `dt-focus&what=hq:3&focus=0.9`, `dt-mansions`, `dt-heli` |
| Street life | `cars`, `people` |

**Add a set whenever you work on a family of models.** Each entry is `{ label, object, size?, update? }`.

## Seeing your work in a headless container

This is a visual product: **always look at a screenshot before calling a change done**, by day and by night.

```bash
# Game, grown city, midday, with UI:
node tools/shot.mjs "http://localhost:5199/?demo&fresh&time=13:00&quality=high" /tmp/day.png --day=end --after=12000

# Whole city at night, no UI, pinned camera:
node tools/shot.mjs "http://localhost:5199/?demo&fresh&time=22:00&view=-11.5,-9.2,0.46" /tmp/night.png --day=end --hide-ui

# A specific day, mobile size:
node tools/shot.mjs "http://localhost:5199/?demo&fresh&time=13:00" /tmp/m.png --day=120 --size=390x844

# Showcase (no timeline, so give a fixed wait):
node tools/shot.mjs "http://localhost:5199/showcase.html?set=homes&zoom=4&time=13" /tmp/homes.png --wait=8000

# Draw calls and triangles for the grown city (needs the dev server, which exposes window.__stage):
node tools/perf.mjs "http://localhost:5199/?demo&fresh&time=13:00&quality=high"
```

Then open the PNG with the Read tool and judge it.

- **Software WebGL (SwiftShader) is slow:** 30–120 s per shot. Give Bash generous timeouts (300 s or more).
- **The camera's auto-framing eases slowly in SwiftShader.** Use `&view=` for reproducible framing.
- **Frozen builds for stable shots.** When several agents edit files, Vite hot-reloads the page mid-shot. Build and preview a snapshot on its own port instead:
  ```bash
  npx vite build --outDir /tmp/tt-dist && npx vite preview --outDir /tmp/tt-dist --port 5220 --strictPort
  ```
  `window.__stage` (for `perf.mjs`) only exists in dev, not in preview.
- For interactions (opening the build menu, hovering, dialogs), copy `tools/shot.mjs` and add `page.click(...)` or `page.keyboard.press('b')` steps.
- Save screenshots in your scratchpad, not the repo. Refresh `docs/images/*.png` only when you mean to update the README.

## Checklist before you commit

1. `npm run typecheck` and `npm test` pass.
2. You looked at a screenshot of what you changed, by day **and** by night, and from the other side (`az=225` or rotate) for models.
3. No new per-frame allocations in hot loops; triangle and draw-call budgets respected (see ARCHITECTURE).
4. `docs/TODO.md` and the "Current state" section of `docs/HANDOFF.md` updated.
5. Commit with a clear message, then push.

## Running parallel agents

For big pushes, split the work by **file ownership** so agents never edit the same file. The split that worked:

- homes and trees: `buildings.ts`
- downtown, items and vehicles: `towers.ts` and `models.ts`
- traffic: `traffic.ts`
- UI: `src/ui/*` and `index.html`
- lead: everything else

In each brief, include:

- the owner's verbatim request;
- the files the agent owns and the exported API it must keep;
- triangle budgets;
- the screenshot commands above, with a frozen-build port of its own;
- "don't commit; report what you built, budgets measured, screenshot paths, and what's left".

The lead integrates, verifies visually and commits. If an agent stops on a usage limit, resume it (`SendMessage` to the same agent) with a short ordered list of what's left.

## Deploying (not set up yet)

The plan is Vercel (static front end + API routes) with Supabase (auth, saves, subscriptions). Until then, `npm run build && npm start` serves everything from one Node process. Don't buy domains or create paid resources without asking the owner.
