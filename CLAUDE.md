# TinyTown: instructions for Claude

**TinyTown is a Tamagotchi for your startup.** A tiny isometric San Francisco Bay, rendered in three.js and driven by a founder's real metrics (Stripe MRR, users, GitHub releases and commits). Every real $1 of MRR becomes $10,000 to spend on the city. Users must be housed ($0.20 of MRR each) or the city decays. The founder's own house climbs from a hacker house to a house on the moon. It's a paid product: $12/month or $99/year, no free trial.

You are picking up a project that already has a lot of history. **Read before you build.**

## Read in this order

1. `docs/HANDOFF.md`: the brain. The story so far, every decision and why, the owner's taste, and where things stand right now.
2. `docs/TODO.md`: the prioritised backlog. Work from the top unless the owner asks for something else.
3. `docs/ARCHITECTURE.md`: the code map, coordinate system, render pipeline, conventions and gotchas.
4. `docs/DEV_WORKFLOW.md`: running, testing, taking screenshots in a headless cloud container, the showcase, URL params, and how to run parallel agents.
5. `docs/GAME_DESIGN.md` (every number in the game) and `docs/PRODUCT.md` (the thesis), when your task touches them.
6. `docs/CONVERSATION_LOG.md`: the owner's messages, verbatim. Read it when you need their exact words or intent.

## Ground rules

- **Quality bar: premium indie game, with Linear/Stripe-level product polish.** The owner has twice called generic output "slop" and asked for a "massive boost" in quality and attention to detail. Never ship emoji-as-icons, purple gradients, generic glassmorphism or placeholder boxes. Every model should read as a real San Francisco thing at a glance.
- **Verify visually.** This is a visual product. After any render or UI change, take a screenshot (`node tools/shot.mjs`, see DEV_WORKFLOW) and look at it with the Read tool before calling it done. Check by day and by night (`time=13:00` and `time=22:00`).
- **The one rule of the game:** the only way to grow the city is to grow the real startup. Never add anything that earns or sells in-game money.
- **Metrics are honest.** The world never fakes a number. Copy always quotes the real number behind a visual.
- **API keys stay server-side** (`server/`). Never ship a key to the browser.
- **Performance:** keep a grown city at a few hundred draw calls. Merge models with `GeoBuilder`, batch homes, instance anything numerous. See the budgets in ARCHITECTURE.

## Commands

```bash
npm install
npm run dev            # Vite on :5173. Demo world: /?demo  (reset: /?demo&fresh)
npm test               # vitest (pure logic: economy, layout, map, events, daylight, server)
npm run typecheck      # tsc --noEmit (the repo's lint; must be clean)
npm run build          # typecheck + production build into dist/
node tools/shot.mjs "<url>" out.png --day=end   # screenshot (see DEV_WORKFLOW)
node tools/perf.mjs "<dev url>"                 # draw calls and triangles for the grown city
```

Run `npm run typecheck` and `npm test` before every commit.

## Conventions

- TypeScript strict with `erasableSyntaxOnly`: no `enum`, no constructor parameter properties, no namespaces.
- Match the surrounding code: small pure modules in `src/world`, `src/game` and `src/data`; rendering in `src/render`; DOM in `src/ui`. Comments explain *why* in plain English, at the density the file already has.
- Compass: +x east, +z north. The camera sits in the north-east looking south-west. Map units: a lot is 1×1, a block is 4×4 lots on a pitch of 5.
- Prose in docs and UI copy: plain, warm, concrete, British/US-neutral. No marketing fluff.

## Git

- Work on the branch the session gives you. If it doesn't give one, branch from the latest work branch (see HANDOFF, "Repository state").
- Commit in coherent steps with clear messages, and push. Never force-push shared history.
- Never put model names or IDs in commits, PRs or code.
- Keep `docs/TODO.md` and the "Current state" section of `docs/HANDOFF.md` up to date as you finish things. They are how the next session picks up.
