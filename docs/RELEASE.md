# Releasing TinyTown

How a change gets from a branch to founders' screens, what checks it on the way, how to undo it, and the one-time settings that make it all work. The pipeline lives in `.github/`; Vercel and Supabase do the deploying.

## The short version

```
branch ──PR──▶ CI (typecheck, tests, build, audit, E2E, CodeQL)   Vercel: preview deploy (test mode)
                 │ all green, squash-merge
                 ▼
main ─────────▶ Vercel: production deploy (live in ~2 minutes)
       └──────▶ CI again ──▶ Migrate database: staging ──▶ production (waits for your approval)
```

- **Code** goes live when it reaches `main`. Vercel's Git integration builds and deploys it; nothing in GitHub Actions deploys code.
- **Database changes** (`supabase/migrations/*.sql`) go to staging, then to production after you approve them, and only after CI has passed on `main`. Pushes that don't touch `supabase/migrations` don't ask.
- Because those two happen side by side, **every migration must work with the code before it and after it**. See [Migrations and deploy order](#migrations-and-deploy-order).

## From a branch to production

1. Branch from `main`. Work, commit, push. Vercel builds a **preview deploy** for every push and comments its link on the pull request.
2. Open a pull request into `main`. The template asks for: what, why, day and night screenshots for anything visual, tests, and (for a migration) how to undo it.
3. CI runs (about 3 to 5 minutes). Every required check must be green. A newer push cancels the older run.
4. Look at the preview. Check the city by day and by night.
5. **Squash and merge.** Vercel deploys `main` to production. CI runs again on `main`; if the merge added a migration, the **Migrate database** job applies it to staging, then waits for your approval for production (GitHub emails you).
6. Approve it (Actions → the run → **Review deployments** → production → **Approve and deploy**) once staging went through cleanly.

If CI fails on `main` after a migration was merged, the migration hasn't run anywhere. Once it's fixed, re-run the failed run (**Re-run failed jobs**), or start it by hand: **Actions → Migrate database → Run workflow**, branch `main`, target `production`. The migrate job only looks at what the latest push changed, so a later push won't pick it up on its own. (Applying is always safe to repeat: with nothing pending, `db push` does nothing.)

A migration ships in **its own pull request, before** the code that needs it. Merge it, approve it, wait for the green tick, then merge the code.

## What CI checks

`.github/workflows/ci.yml`, on every pull request and every push to `main`:

| Check | What it does | Blocks a merge |
|---|---|---|
| **Typecheck** | `npm run typecheck` | yes |
| **Unit tests** | `npm test`: game logic, server, and the migrations lint (every table has row-level security on) | yes |
| **Build** | `npm run build`, then `node server/build-vercel.mjs`, exactly what Vercel runs, including the smoke test that loads the API function. On pull requests the built `dist/` is attached to the run for 7 days | yes |
| **Audit** | `npm audit --omit=dev --audit-level=high` fails on a high or critical advisory in anything that ships (two packages today). A full audit including build tools runs too, but only reports | yes |
| **Dependency review** | On pull requests: fails if the change *adds* a runtime dependency with a high or critical advisory | yes |
| **E2E** | `node tools/e2e.mjs` in headless Chromium, once that file exists; until then it passes with a note. Screenshots in `e2e-output/` are attached when it fails | yes |
| **Analyze (javascript-typescript)**, **Analyze (actions)** | CodeQL (`codeql.yml`): security bugs in our code and in these workflows. Findings: Security → Code scanning | yes |
| **Migrate database** | On `main` only, after Typecheck, Unit tests and Build. See below | n/a |

**Why the audit blocks.** The runtime tree is tiny (`three` and `@supabase/supabase-js`), so a high advisory there is rare and real: it reaches founders' browsers or the API. Blocking costs almost nothing and stops us shipping a known hole to paying customers. Build and test tools never reach production, and their advisories are mostly about dev servers, so they're report-only; Dependabot opens the upgrade either way. If an advisory has no fix yet and doesn't affect us, the way out is an `overrides` entry in `package.json` with a comment, not switching the check off.

All of this is free for a public repository.

## One-time setup (the owner)

Work through these once. Everything in GitHub is under the repository's **Settings** tab.

### 1. Make `main` the default branch

**Settings → General → Default branch** → the ⇄ button → `main` → **Update**. Scheduled CodeQL runs, Dependabot's config and the **Run workflow** button all read the default branch. (Dependabot already targets `main` explicitly, so its pull requests are right either way.)

While you're there, under **Pull Requests**: allow **squash merging** only, tick **Always suggest updating pull request branches** and **Automatically delete head branches**.

### 2. Protect `main`

**Settings → Rules → Rulesets → New ruleset → New branch ruleset.**

- **Ruleset name:** `main`. **Enforcement status:** Active.
- **Bypass list → Add bypass → Repository admin**, set to **For pull requests only**. This lets you merge a pull request in an emergency (say, GitHub Actions is down) but never push straight to `main`.
- **Target branches → Add target → Include by pattern** → `main`.
- Rules, ticked:
  - **Restrict deletions**
  - **Require linear history**
  - **Require a pull request before merging**: required approvals **0** (GitHub won't let you approve your own pull request; raise it when there's a second person). Tick **Require conversation resolution before merging**. Allowed merge methods: **Squash**.
  - **Require status checks to pass**: tick **Require branches to be up to date before merging**, then **Add checks** and add: `Typecheck`, `Unit tests`, `Build`, `Audit`, `Dependency review`, `E2E`, `Analyze (javascript-typescript)`, `Analyze (actions)`. A check only appears in the search after it has run once, so open one pull request first.
  - **Block force pushes**
  - Optional: **Require code scanning results** → CodeQL, security alerts **High or higher**.
- **Create.**

Optional: a second ruleset (**New tag ruleset**, target `v*`) with **Restrict updates** and **Restrict deletions**, so a release tag can't be moved.

### 3. Lock down Actions

**Settings → Actions → General:**

- **Actions permissions:** **Allow rayhankhilji, and select non-rayhankhilji, actions and reusable workflows** → tick **Allow actions created by GitHub**, and under **Allow specified actions** enter `supabase/setup-cli@*, oven-sh/setup-bun@*` (the second is used inside the first). If the page offers **Require actions to be pinned to a full-length commit SHA**, tick it: every action here already is.
- **Approval for running fork pull request workflows from contributors:** **Require approval for all external contributors**.
- **Workflow permissions:** **Read repository contents and packages permissions**, and untick **Allow GitHub Actions to create and approve pull requests**.

### 4. Environments and secrets for migrations

Migrations need three values per database. They live as **environment secrets**, never repository secrets: the migrate workflow only reads them from inside its environment, and production's environment needs your approval.

| Secret | Where to get it |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) → **Generate new token**, name it `GitHub Actions: TinyTown`. It can reach every project in your Supabase account, which is why it lives behind an approval. |
| `SUPABASE_DB_PASSWORD` | The database password you saved when creating the project. Lost it? Supabase → **Project Settings → Database → Reset database password**. TinyTown's app doesn't use it (it uses the API keys), so resetting is safe. |
| `SUPABASE_PROJECT_REF` | The 20-letter id in the project's dashboard address (`supabase.com/dashboard/project/<ref>`), also under **Project Settings → General**. |

**Settings → Environments → New environment:**

- **`production`**
  - **Required reviewers:** tick it, add `rayhankhilji`. Leave **Prevent self-review** off (you are the reviewer of your own merges). Untick **Allow administrators to bypass configured protection rules**.
  - **Deployment branches and tags:** **Selected branches and tags → Add deployment branch or tag rule** → `main`.
  - **Environment secrets:** the three secrets for the **production** Supabase project.
- **`staging`** (recommended): a second Supabase project that preview deploys also use (below).
  - No reviewers. Deployment branches: **No restriction**, so you can try a pull request's migration on staging by hand.
  - **Environment secrets:** the same three names, with the **staging** project's values.

Until an environment has its secrets, its migrate step is skipped with a warning and CI stays green, so the order you do this in doesn't matter. Without a staging environment, production simply goes first.

A free Supabase project pauses after a week without traffic. If staging is paused, its migration fails and production waits: restore it from the Supabase dashboard and re-run the job.

### 5. Tell Supabase what already ran

The first production database was set up by pasting `0001_init.sql` into the SQL Editor (docs/SETUP.md), so Supabase's migration history is empty and `db push` would try to run it again and fail. Once, from your machine, for each project:

```bash
npx supabase@2.118.0 login
npx supabase@2.118.0 link --project-ref <ref>      # asks for the database password
npx supabase@2.118.0 migration list                # "Remote" is blank for files you ran by hand
npx supabase@2.118.0 migration repair --status applied 0001   # plus any other file you pasted in
npx supabase@2.118.0 migration list                # now both columns match
```

From then on, never paste a migration into the SQL Editor: merge it and let the pipeline run it.

### 6. Security features

**Settings → Advanced Security** (all free on a public repository):

- **Dependency graph**, **Dependabot alerts**, **Dependabot security updates** and **Grouped security updates**: on.
- **Secret Protection** (secret scanning) and **Push protection**: on. Push protection refuses a push that contains a recognisable key (Stripe, Supabase, GitHub and many more) before it ever reaches GitHub. If it fires, the key was on your disk in a commit: remove it from the commit, and if it was ever pushed anywhere, roll it in the provider's dashboard.
- **Private vulnerability reporting:** on. The bug report form links to it.
- **Code scanning:** leave **CodeQL analysis** on *advanced* (our `codeql.yml`). Don't switch on *default setup* as well: it would stop our workflow from uploading.

**This repository is public.** Anyone can read the code, so nothing secret may ever be committed: keys live in Vercel and in GitHub environment secrets only.

Dependabot (`.github/dependabot.yml`) opens update pull requests every Monday: one grouped pull request for npm minor and patch updates, one for GitHub Actions, and separate ones for major versions. It waits until a release is a week old before proposing it. Security updates don't wait.

### 7. Vercel

In the Vercel project (docs/SETUP.md section 6 creates it):

- **Settings → Git → Production Branch:** `main`. Vercel picks the repository's default branch when you import, which may not be `main`.
- **Settings → Git → Git Fork Protection:** on (the default). A pull request from a fork never builds with our environment variables unless you authorise it.
- **Settings → Deployment Protection → Vercel Authentication:** **Standard Protection** (the default), so preview links only open for members of your Vercel team.
- **Settings → Environment Variables:** keep **Automatically expose System Environment Variables** ticked. The build id comes from one of them.
- **Settings → Build and Deployment → Node.js Version:** `22.x`, matching CI and the function runtime.
- If your project settings offer **Deployment Checks**, add `Typecheck`, `Unit tests` and `Build`: Vercel then builds production straight away but only switches the domain to it once those pass on GitHub.

## Preview deploys and their environment variables

Every branch push gets its own preview deploy at a `*.vercel.app` address. Preview code hasn't been reviewed yet, so previews must **never** see production data or live money:

- In **Settings → Environment Variables**, each variable has a **Production** value and a separate **Preview** value. Add every variable from docs/SETUP.md twice:
  - **Production:** live Stripe keys and prices, the production Supabase project.
  - **Preview:** test-mode Stripe keys (`sk_test_…`, test prices, a test-mode webhook secret), the **staging** Supabase project's URL and keys, its own `TOKEN_ENCRYPTION_KEY` and `STATE_SECRET`, and `ALLOW_TEST_MODE=1` so test-mode Stripe data can drive a city.
- Return addresses (Stripe Checkout, sign-in links) need a fixed address, and preview addresses change with every push. To test sign-in and checkout end to end, use a **`staging` branch with its own domain**: **Settings → Domains → Add** `staging.YOUR-DOMAIN` → **Connect to an environment: Preview**, **Git branch:** `staging`. Then add `APP_URL=https://staging.YOUR-DOMAIN` for **Preview**, limited to the `staging` branch, and point the staging Supabase project's **Site URL** and the test-mode Stripe webhook at that address. Ordinary previews are for looking at the city and the screens.
- Vercel Cron runs only on production, so previews never run the hourly, daily and weekly jobs.

## Migrations and deploy order

Vercel puts new code live a minute or two after a merge. The migration for that merge runs a few minutes later, after CI, and production waits for your approval, which could be hours. And an instant rollback (below) puts old code in front of the new schema. So at any moment, the live code may be one version ahead of the database, or one version behind. The rule that keeps that safe:

**Expand, then contract.** Every migration must work with the code already running *and* the code about to run.

- **Expand** (safe any time): add a table; add a column that is nullable or has a default; add an index; add a function. Old code ignores them.
- **Contract** (only once nothing uses the old shape): drop or rename a column or table, add `not null` to an existing column, tighten a check.

A change that needs both is three pull requests. Renaming `worlds.name` to `worlds.title`, for example:

1. **Expand:** a migration adds `title` (nullable) and copies `name` into it. Merge, approve, wait for green.
2. **Code:** the server writes both columns and reads `title`. Merge; let it run for a day or two, longer than you'd ever roll back.
3. **Contract:** a migration drops `name`, and the code stops writing it.

And always:

- Migrations ship in their own pull request, before the code that uses them.
- New tables have row-level security on and no policies (the server-only pattern in `0001_init.sql`). The unit tests check this.
- Number files in sequence (`0007_…sql`), never edit one that has run, and keep each one fast: they run inside a deploy window.
- Write the undo SQL in the pull request description (the template asks). That's the rollback plan.

## Rolling back

### The site

Vercel keeps every deployment, and switching back is instant (no rebuild):

- Vercel → the project → **Deployments** → the last good production deployment → **⋯ → Instant Rollback** (or the **Instant Rollback** button on the project's overview). From a terminal: `npx vercel rollback`.
- After a rollback, Vercel **stops promoting new production deploys** until you undo it, so a push to `main` won't silently put the broken code back. Once the fix is merged and its deploy looks right, open it in **Deployments → ⋯ → Promote**, or **Undo Rollback**.
- A rolled-back deployment keeps the environment variables it was built with. If the problem was a variable, change it and **Redeploy** instead.

Rolling back code never touches the database, which is why migrations have to be backward compatible.

### The database

Supabase migrations only go forward; there are no down files. In order of preference:

1. **Fix forward.** Write a new migration that undoes the change (the undo SQL from the pull request), merge it, approve it. History stays honest.
2. **Emergency undo by hand**, when production is broken and the pipeline is too slow: run the undo SQL in Supabase's SQL Editor, then record it so history matches the database, and revert the file in git:
   ```bash
   npx supabase@2.118.0 migration repair --status reverted 0007
   git revert <the migration's commit>   # through a pull request, as always
   ```
3. **Restore a backup** (last resort: it loses everything written since). Supabase Pro keeps daily backups for 7 days (**Database → Backups**); point-in-time recovery is a paid add-on worth turning on once founders are paying.

## Hotfixes

Same road, just faster:

1. Site badly broken? **Roll back on Vercel first** (seconds), then fix calmly.
2. Branch `hotfix/<what>` from `main`, fix, open a pull request. CI takes about 5 minutes; wait for it.
3. Squash and merge. If you rolled back, promote the new deploy (above).
4. If CI itself is broken (a GitHub outage, not a failing test), the admin bypass on the ruleset lets you merge the pull request anyway. Never push straight to `main`.

## Release tags

Tags mark what founders were running and when, for support and for reading error reports. Calendar versions: `vYYYY.MM.DD`, and `vYYYY.MM.DD.2` for a second one the same day. Tag a commit that's on `main` and live in production, once you've checked it:

```bash
git fetch origin
git tag -a v2026.10.20 -m "Short summary" origin/main
git push origin v2026.10.20
```

`.github/workflows/release.yml` turns the tag into a GitHub Release with notes built from the merged pull requests (and refuses a tag that isn't on `main`). Tagging doesn't deploy anything; Vercel already did.

## The build id (`VITE_RELEASE`)

Error reports from the browser carry a `release` (src/telemetry.ts reads `import.meta.env.VITE_RELEASE`), and the server's logs and analytics carry the same id (`releaseOf` in server/log.ts). It's the first 12 characters of the commit being built:

- On Vercel, from `VERCEL_GIT_COMMIT_SHA` (a system environment variable, present at build time and at run time).
- In GitHub Actions, from `GITHUB_SHA`.
- Set `RELEASE` to override it (both sides use it); locally it's `dev`.

`vite.config.ts` sets it for the browser with a `define`. To find the commit behind a report: `git show <release>`, or search the id in Vercel's **Deployments** list.

## Maintaining the pipeline

- **Actions are pinned to full commit SHAs** with the version in a comment (`@3d3c42e… # v7.0.1`). A tag can be moved to point at different code; a SHA can't. Dependabot updates the SHA and the comment together, a week after a release at the earliest.
- **The Supabase CLI version** is `SUPABASE_CLI_VERSION` in `.github/workflows/migrate.yml`. Dependabot can't see it; bump it by hand every few months.
- **Lint workflows before pushing them** with [actionlint](https://github.com/rhysd/actionlint): download the binary from its releases page and run `actionlint` at the repository root.
- Job names are the required check names. Renaming a job means updating the ruleset too, or pull requests wait forever for a check that never comes.
- Local actions: `.github/actions/setup` (Node 22, npm cache, `npm ci`) and `.github/actions/migrate` (link, list, dry run, `db push`).
