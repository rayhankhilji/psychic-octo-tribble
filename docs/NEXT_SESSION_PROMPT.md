# Starting a new Claude cloud session on TinyTown

Copy the prompt below into a new Claude Code session on the web (claude.ai/code), with this repository selected and the branch set to `claude/tender-keller-mnunoy` (or `main`, once it exists).

`CLAUDE.md` loads automatically. The prompt makes the session read the rest of the brain before it touches anything.

---

## The prompt

```text
You're taking over TinyTown, my startup's product: "a Tamagotchi for your startup", a tiny isometric San Francisco Bay in three.js that grows from a founder's real metrics, with a full city-builder game on top. A previous Claude session built everything so far and left a handoff.

Before doing anything else, read these in order and don't skim:
1. CLAUDE.md (rules, commands, quality bar)
2. docs/HANDOFF.md (the project brain: history, every decision and why, my taste, current state)
3. docs/TODO.md (the prioritised backlog)
4. docs/ARCHITECTURE.md (code map, coordinates, render pipeline, gotchas)
5. docs/DEV_WORKFLOW.md (how to run, test and screenshot in this headless container)
6. docs/CONVERSATION_LOG.md (my original messages, verbatim)
Skim docs/GAME_DESIGN.md and docs/PRODUCT.md too.

Then:
- Run `npm run typecheck` and `npm test`, start the dev server in the background, and take a day and a night screenshot of the grown demo city with tools/shot.mjs. Look at them, so you've seen the current state with your own eyes.
- Give me a short brief, no more than 15 lines: what you understand TinyTown to be, the current state, anything broken, and the top 5 things you plan to do from docs/TODO.md, in order.
- Then start on them without waiting for me, unless something needs my decision (pricing, accounts, spending money, creating branches or deploying). For those, ask first with a clear recommendation.

How I want you to work:
- My quality bar is a premium indie game with Linear/Stripe-level polish. I've called generic output slop before. Verify every visual change with a screenshot, by day and by night.
- For big pushes, run parallel agents that own disjoint files (see docs/DEV_WORKFLOW.md, "Running parallel agents"). You integrate, verify and commit.
- Commit in coherent steps and push to the working branch. Keep docs/TODO.md and the "Current state" section of docs/HANDOFF.md up to date as you go, so the next session can pick up from you the same way.
- When you finish a chunk, tell me exactly how to try it (commands or URL, and what to look at).
```

---

## Shorter variants

**Pick a specific task:**

```text
Read CLAUDE.md, docs/HANDOFF.md and docs/TODO.md first. Then do <task>, e.g. "P3: the 'while you were away' summary", following CLAUDE.md. Screenshot the result by day and by night, update TODO.md and HANDOFF.md, commit and push, and tell me how to try it.
```

**Start the hosted product:**

```text
Read CLAUDE.md, docs/HANDOFF.md, docs/TODO.md and docs/GAME_DESIGN.md first. Then plan P4 (the hosted product: Supabase auth and saves, server-authoritative simulate(), Connect with Stripe read-only, PostHog, billing at $12/mo or $99/yr with no free trial, deploy on Vercel). Show me the plan and the decisions you need from me before writing code.
```

---

## How the docs are organised

| File | What's in it | When to read |
|---|---|---|
| `CLAUDE.md` | Rules, commands, conventions, quality bar, git | Loads automatically every session |
| `docs/HANDOFF.md` | **The brain:** product summary, the owner's taste and working style, project history, decisions and why, current state, how the agents were run, ideas not yet built | First, every new session |
| `docs/TODO.md` | Prioritised backlog (P0–P6) with agent leftovers | Before choosing work; update it when done |
| `docs/ARCHITECTURE.md` | Data flow, source map, world coordinates, GeoBuilder, budgets, rendering gotchas, UI and server | Before changing code |
| `docs/DEV_WORKFLOW.md` | Setup, commands, URL params, showcase, headless screenshots, commit checklist, parallel agents, deploy plan | Before running or verifying anything |
| `docs/GAME_DESIGN.md` | Every number in the game: money, housing, decay, satisfaction, house ladder, land, catalogue, pricing, edge cases | When touching game logic or the catalogue |
| `docs/PRODUCT.md` | The product thesis, risks, how we'll know it works | When making product calls |
| `docs/CONVERSATION_LOG.md` | The owner's messages, verbatim, plus Claude's two design proposals | When you need exact intent or tone |
| `README.md` | Public-facing overview and setup | When the product changes |
| `tools/` | `shot.mjs` (screenshots), `perf.mjs` (draw calls and triangles), `playwright.mjs` (shared helpers) | Whenever you need to see the app |
| `.claude/` | SessionStart hook: `npm install` in cloud sessions | Automatic |
