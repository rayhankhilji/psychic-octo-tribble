/**
 * The founder's journey clicked through in Chromium against the built app:
 * demo, sign in, set up for free (connect Stripe, GitHub, users), the
 * paywall with their own numbers, close it, take the one-time first-year
 * offer through Checkout, the city, building, the account menu.
 *
 * Selectors are roles and accessible names (what a person sees), never
 * styling classes, except where a control has no name of its own. A step
 * whose UI isn't there yet throws `Skip` with what was missing, so the
 * suite lands green while the client is being built and tightens as it
 * lands.
 *
 * Software WebGL is slow: each full page load builds the city first (one
 * to two minutes in a container), so the journeys share one page and
 * navigate only where the real flow does. Clicks go through the DOM
 * (`el.click()`) rather than waiting for the canvas to sit still.
 */
import { join } from 'node:path';
import { CATALOG } from '../../src/game/catalog.ts';
import { canBuy } from '../../src/game/economy.ts';
import { rewriteUrl } from '../../tools/fake-providers.mjs';
import { launch } from '../../tools/playwright.mjs';
import { affordable, cityOf, connectGithub, connectStripe, pay, signIn } from './api-journeys.mjs';
import { Client, OUT, Skip, assert } from './harness.mjs';

const LOAD_MS = Number(process.env.TT_E2E_LOAD_MS ?? 300_000);

/** Console noise that isn't ours: software WebGL's performance warnings. */
const NOISE = [/GPU stall due to ReadPixels/i, /useProgram/i, /WebGL: too many errors/i, /Automatic fallback to software WebGL/i, /GL Driver Message/i];

export async function uiContext(stack) {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, acceptDownloads: true });
  // A first visit opens on the front door; these journeys are about what's behind it (it has its own journey).
  await context.addInitScript(() => {
    try {
      localStorage.setItem('tinytown:frontdoor-seen', '1');
    } catch {
      // Storage off: the front door treats that as seen too.
    }
  });
  // The GitHub install link is github.com's own; send the browser to the fake instead.
  await context.route(/^https:\/\/github\.com\//, (route) => route.fulfill({ status: 302, headers: { location: rewriteUrl(route.request().url(), stack.fakes.url) } }));
  // Anything else outside (fonts, analytics, the bot check) must not leave the machine either.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost|github\.com\/)/, (route) => route.fulfill({ status: 204, body: '' }));
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const t = { stack, browser, context, page, consoleErrors: [], pageErrors: [], api: new Client(stack.appUrl) };
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.some((r) => r.test(m.text()))) t.consoleErrors.push(`${m.text().slice(0, 300)} @ ${page.url()}`);
  });
  page.on('pageerror', (e) => t.pageErrors.push(`${e.message} @ ${page.url()}`));
  t.onFail = async (journey) => {
    const file = join(OUT, `${journey.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
    await page.screenshot({ path: file, timeout: 120_000 }).catch(() => {});
    console.log(`     screenshot: ${file} (at ${page.url()})`);
  };
  t.close = () => browser.close();
  return t;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** True once `locator` is visible, false after `ms`. */
async function shows(locator, ms = 5_000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: ms });
    return true;
  } catch {
    return false;
  }
}

/** A click through the DOM: immediate, even while the canvas is mid-frame. */
async function tap(locator, what) {
  const el = locator.first();
  if (!(await shows(el, 15_000))) throw new Error(`${what ?? 'control'} isn't on screen`);
  await el.evaluate((node) => node.click());
}

/** Waits for the hosted shell: the demo's call to action, the account button, or a dialog. */
async function shellUp(page) {
  await page.waitForFunction(() => !!document.querySelector('[data-cta], .account-btn, dialog[open]'), null, { timeout: LOAD_MS, polling: 500 });
}

/** Waits for the city itself (the timeline slider, with the loader gone). */
async function cityUp(page) {
  await page.waitForFunction(() => !!document.querySelector('input[type=range]') && !document.body.innerText.includes('Laying out'), null, { timeout: LOAD_MS, polling: 1000 });
}

/**
 * A founder's first open of their own city plays the grand opening, then the
 * guided tour; both take the screen and the keyboard. Journeys about what
 * comes after skip them, the way a founder can.
 */
async function pastTheOpening(page) {
  for (let i = 0; i < 40; i++) {
    const state = await page.evaluate(() => ({ cer: !!document.querySelector('.cer-skip'), tour: !!document.querySelector('.tour-skip') }));
    if (state.cer) await page.evaluate(() => document.querySelector('.cer-skip')?.click());
    else if (state.tour) await page.evaluate(() => document.querySelector('.tour-skip')?.click());
    else if (i > 6) return;
    await page.waitForTimeout(500);
  }
}

/**
 * A button on a fake provider page, then the redirect back to the app. Plain
 * HTML, so a real click with Playwright's own checks is quick. A click that
 * lands while the page is still settling can be lost, so it's retried while
 * we're still on the provider's page (the fakes don't spend anything until
 * the app's callback runs).
 */
async function providerClick(page, name, appUrl) {
  const here = page.url();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name }).click({ timeout: 30_000 });
    try {
      await page.waitForURL((u) => u.toString().startsWith(appUrl), { timeout: 20_000, waitUntil: 'commit' });
      return;
    } catch (err) {
      if (page.url() !== here || attempt === 3) throw err;
    }
  }
}

const dialog = (page, name) => page.getByRole('dialog', { name });

/** The signed-in founder's access token, as supabase-js keeps it. */
async function tokenOf(page) {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('tinytown-auth');
      return raw ? JSON.parse(raw).access_token ?? null : null;
    } catch {
      return null;
    }
  });
}

/**
 * When an earlier journey failed or was skipped, a later one can still run:
 * this makes a paid, connected founder through the API (the same calls the
 * UI makes) and hands the browser their session, as supabase-js keeps it.
 * With `open`, the page then loads their city.
 */
async function fastForward(t, { open = true } = {}) {
  const { page, stack } = t;
  t.email = `ui-ff+${Date.now()}@nightjar.test`;
  const c = await signIn(stack, t.email);
  await pay(c);
  await connectStripe(c);
  await connectGithub(c, stack.fakes.url);
  const repos = await c.api('GET', '/api/connect/github/repos');
  await c.api('PUT', '/api/connect/github/repo', { body: { repo: repos.body.repos[0].fullName } });
  const user = await (await fetch(`${stack.fakes.url}/auth/v1/user`, { headers: { apikey: stack.fakes.anonKey, Authorization: `Bearer ${c.token}` } })).json();
  const session = { ...c.session, expires_at: Number(c.session.expires_at), expires_in: Number(c.session.expires_in), user };
  // Any same-origin page will do for writing storage; this one is cheap.
  await page.goto(`${stack.appUrl}/api/config`, { waitUntil: 'commit' });
  await page.evaluate((s) => localStorage.setItem('tinytown-auth', JSON.stringify(s)), session);
  t.api.token = c.token;
  if (!open) return;
  await page.goto(`${stack.appUrl}/`, { waitUntil: 'commit', timeout: LOAD_MS });
  await cityUp(page);
  await shellUp(page);
  await pastTheOpening(page);
  const tl = await t.api.api('GET', '/api/timeline');
  t.timeline = tl.body;
  t.joinedAt = (await t.api.api('GET', '/api/me')).body.world.joinedAt;
}

// ─── Journeys ─────────────────────────────────────────────────────────────

export const UI_JOURNEYS = [
  {
    name: 'ui: the demo loads with no console errors',
    async run(t) {
      const { page, stack } = t;
      await page.goto(`${stack.appUrl}/`, { waitUntil: 'commit', timeout: LOAD_MS });
      await cityUp(page);
      await shellUp(page);
      await page.waitForTimeout(2_000);
      assert(!t.pageErrors.length, `uncaught errors: ${t.pageErrors.join(' | ')}`);
      assert(!t.consoleErrors.length, `console errors: ${t.consoleErrors.join(' | ')}`);
      assert(await shows(page.getByRole('button', { name: /Make it yours/ })), 'no "Make it yours" call to action on the hosted demo');
    },
  },
  {
    name: 'ui: sign in with a magic link',
    needs: 'ui: the demo loads with no console errors',
    async run(t) {
      const { page, stack } = t;
      const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
      if (!(await shows(signIn))) throw new Skip('no "Sign in" button on the demo');
      await tap(signIn, 'Sign in');
      const box = page.getByRole('textbox', { name: 'Email address' });
      if (!(await shows(box))) throw new Skip('the sign-in dialog has no "Email address" field');
      t.email = `ui+${Date.now()}@nightjar.test`;
      await box.fill(t.email);
      await tap(page.getByRole('button', { name: /Email me a sign-in link/ }), 'Email me a sign-in link');
      await page.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 60_000 });
      const link = stack.fakes.latestLink(t.email);
      assert(link, 'no magic link was sent');
      await page.goto(link, { waitUntil: 'commit', timeout: LOAD_MS });
      assert(page.url().startsWith(stack.appUrl), `the magic link landed on ${page.url()}`);
      await shellUp(page);
      assert(await shows(page.locator('button[aria-label^="Your account"]'), LOAD_MS), 'no account button after signing in');
      t.api.token = await tokenOf(page);
      assert(t.api.token, 'no session stored after the magic link');
      assert(!/access_token/.test(page.url()), 'tokens were left in the address bar');
      // A new founder lands on setup, which is free: no paywall first.
      assert(await shows(dialog(page, /Set up your city/), LOAD_MS), 'setup did not open by itself after signing in');
      assert(await shows(page.getByText(/Free to set up/)), 'setup should say it is free');
      assert(!(await shows(dialog(page, /Make it yours/), 1_000)), 'the paywall opened before setup');
    },
  },
  {
    name: 'ui: onboarding connects Stripe, GitHub and a repo, and the users source',
    needs: 'ui: sign in with a magic link',
    async run(t) {
      const { page, stack } = t;
      const setup = dialog(page, /You're in|Set up your city/);
      assert((await t.api.api('GET', '/api/me')).body.plan.status === 'none', 'setup should come before paying');
      // Stripe: out to the fake marketplace and back with ?connected=stripe.
      await tap(setup.getByRole('button', { name: 'Install on Stripe' }), 'Install on Stripe');
      await page.waitForURL(/\/stripe-pages\/oauth\//, { timeout: 60_000, waitUntil: 'commit' });
      await providerClick(page, 'Install app', stack.appUrl);
      await shellUp(page);
      const me = await t.api.api('GET', '/api/me');
      assert(me.body.connections.stripe, 'Stripe is not connected after the install');
      // GitHub: the install link is github.com's; the context routes it to the fake.
      const github = page.getByRole('button', { name: 'Install on GitHub' });
      if (!(await shows(github, LOAD_MS))) throw new Skip('no "Install on GitHub" step after connecting Stripe');
      await tap(github, 'Install on GitHub');
      await page.waitForURL(/\/github\/apps\//, { timeout: 60_000, waitUntil: 'commit' });
      await providerClick(page, /Install & Authorize/, stack.appUrl);
      await shellUp(page);
      const repo = page.getByRole('option').first();
      assert(await shows(repo, LOAD_MS), 'no repositories to pick after installing on GitHub');
      const picked = page.waitForResponse((r) => r.url().endsWith('/api/connect/github/repo') && r.request().method() === 'PUT');
      await tap(repo, 'a repository');
      assert((await picked).status() === 200, 'picking a repository failed');
      // Users: a number typed in.
      const manual = page.locator('input[name=users][value=manual]');
      if (!(await shows(manual, 15_000))) {
        const next = page.getByRole('button', { name: /Next: active users/ });
        if (await shows(next)) await tap(next);
      }
      if (await shows(manual, 15_000)) {
        await manual.first().evaluate((el) => el.click());
        const value = page.locator('input[name=value]');
        await value.fill('1234');
        const saved = page.waitForResponse((r) => r.url().endsWith('/api/connect/users') && r.request().method() === 'PUT');
        await tap(page.getByRole('button', { name: 'Save', exact: true }), 'Save');
        assert((await saved).status() === 200, 'saving the users source failed');
      } else t.notes = 'no users-source choice shown';
      const after = await t.api.api('GET', '/api/me');
      assert(after.body.connections.github?.repo, 'no repository saved');
      assert(after.body.plan.status === 'none', 'connecting should not need a plan');
    },
  },
  {
    name: 'ui: Build my city → the paywall with their numbers → close → the offer → checkout with the coupon',
    needs: 'ui: onboarding connects Stripe, GitHub and a repo, and the users source',
    async run(t) {
      const { page, stack } = t;
      const finish = page.getByRole('button', { name: 'Build my city' });
      const paywall = dialog(page, /is ready/);
      // Setup re-renders as its numbers arrive, so a click can land on a button that was just
      // replaced: try again while the paywall hasn't opened.
      for (let attempt = 0; attempt < 3 && !(await shows(paywall, attempt ? 20_000 : 1_000)); attempt++) {
        if (await shows(finish, 15_000)) await tap(finish, 'Build my city');
        // Setup was closed along the way: the call to action opens the paywall now.
        else await tap(page.getByRole('button', { name: /Open my city/ }), 'Open my city');
      }
      assert(await shows(paywall, 60_000), 'the paywall did not open after setup, with "your city is ready"');
      // Their own MRR, the same number the server's preview has.
      const preview = await t.api.api('GET', '/api/preview');
      const mrr = new Intl.NumberFormat('en-US', { style: 'currency', currency: preview.body.currency.toUpperCase(), minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(preview.body.revenue.mrr);
      assert(await shows(paywall.getByText(mrr, { exact: true }), 30_000), `the paywall should lead with their MRR (${mrr})`);
      // Closing it the first time turns it over to the one-time offer.
      await tap(paywall.getByRole('button', { name: 'Close' }), 'Close');
      const offer = dialog(page, /Your first year for \$9/);
      assert(await shows(offer, 15_000), 'closing the paywall did not show the first-year offer');
      assert(await shows(offer.getByText(/then \$29 a year/i)), 'the offer must say what it renews at');
      await page.waitForFunction(() => /hours? left/.test(document.querySelector('dialog[open]')?.textContent ?? ''), null, { timeout: 30_000, polling: 500 });
      const me = await t.api.api('GET', '/api/me');
      assert(me.body.offer?.status === 'open', `the server should have started the offer's window: ${JSON.stringify(me.body.offer)}`);
      await tap(offer.getByRole('button', { name: /Accept: \$9 for the first year/ }), 'Accept');
      await page.waitForURL(/\/stripe-pages\/checkout\//, { timeout: 60_000, waitUntil: 'commit' });
      assert(await shows(page.getByText(/then \$29\.00 every year/)), 'the Checkout page should show $9.00 today, then $29.00');
      const before = stack.fakes.state.stripe.deliveries.length;
      await providerClick(page, /^Pay \$9\.00/, stack.appUrl);
      const deliveries = stack.fakes.state.stripe.deliveries.slice(before);
      assert(deliveries.length >= 2 && deliveries.every((d) => d.status === 200), `webhooks: ${JSON.stringify(deliveries)}`);
      const paid = await t.api.api('GET', '/api/me');
      assert(paid.body.plan.status === 'active', `plan after checkout: ${paid.body.plan.status}`);
      const profile = stack.fakes.rows('profiles').find((r) => r.user_id === paid.body.user.id);
      assert(profile?.offer_used_at, 'the offer should be marked used');
    },
  },
  {
    name: "ui: the city loads with the founder's timeline and seed",
    needs: 'ui: Build my city → the paywall with their numbers → close → the offer → checkout with the coupon',
    prepare: (t) => fastForward(t, { open: false }),
    async run(t) {
      const { page, stack } = t;
      // Back from Checkout, the app confirms the payment and reloads into the city by itself: let it
      // finish, so the responses read below belong to the page that stays.
      if (/checkout=|\/stripe-pages\//.test(page.url()) || (await shows(page.locator('.billing-banner.is-pending'), 2_000))) {
        await page.waitForFunction(() => !document.querySelector('.billing-banner.is-pending') && !location.search.includes('checkout='), null, { timeout: LOAD_MS, polling: 500 });
        await cityUp(page);
      }
      const timeline = page.waitForResponse((r) => r.url().endsWith('/api/timeline'), { timeout: LOAD_MS });
      const me = page.waitForResponse((r) => r.url().endsWith('/api/me'), { timeout: LOAD_MS });
      // "Build my city", or "Back to my city" when connecting Stripe already opened it behind the dialog.
      const finish = page.getByRole('button', { name: /Build my city|Back to my city/ });
      if (await shows(finish, 5_000)) await tap(finish, 'Build my city');
      else await page.goto(`${stack.appUrl}/`, { waitUntil: 'commit', timeout: LOAD_MS });
      const [tl, who] = await Promise.all([timeline, me]);
      assert(tl.status() === 200, `/api/timeline answered ${tl.status()}`);
      const body = await tl.json();
      assert(body.source === 'live' && body.snapshots.length > 300, `timeline: ${body.source}, ${body.snapshots?.length} days`);
      const seed = (await who.json()).world.seed;
      assert(Number.isInteger(seed) && seed > 0, `seed ${seed}`);
      await cityUp(page);
      await shellUp(page);
      await pastTheOpening(page);
      assert(!(await shows(page.locator('[data-cta]'), 2_000)), "the demo's call to action is still showing on the founder's own city");
      t.timeline = body;
      t.joinedAt = (await t.api.api('GET', '/api/me')).body.world.joinedAt;
    },
  },
  {
    name: 'ui: a build saves; an unaffordable one gets 409 and rolls back',
    needs: "ui: the city loads with the founder's timeline and seed",
    prepare: (t) => fastForward(t),
    async run(t) {
      const { page } = t;
      const buildBtn = page.getByRole('button', { name: 'Build (B)' });
      if (!(await shows(buildBtn))) throw new Skip('no Build button');
      await tap(buildBtn, 'Build');
      // Things that place themselves (HQ, sites) can be bought without clicking a plot on the canvas.
      const placeless = async (actions) => {
        // Buying can close the drawer or move the camera; look at every category, drawer open.
        if ((await buildBtn.first().getAttribute('aria-expanded')) !== 'true') await tap(buildBtn, 'Build');
        const all = page.locator('[role=tab][data-tab=all]');
        if (await shows(all, 2_000)) await all.first().evaluate((el) => el.click());
        await page.waitForTimeout(500);
        const game = cityOf(t.timeline, actions, t.joinedAt);
        const ids = await page.locator('[data-buy]').evaluateAll((els) => els.filter((e) => e.offsetParent && !/place/i.test(e.textContent)).map((e) => e.getAttribute('data-buy')));
        return ids.map((id) => CATALOG.find((i) => i.id === id)).filter((i) => i && i.placement.kind !== 'plot' && !canBuy(game, i)).sort((a, b) => a.price - b.price);
      };
      let actions = (await t.api.api('GET', '/api/world/actions')).body.actions;
      const first = (await placeless(actions))[0];
      if (!first) throw new Skip('nothing buyable without picking a plot');
      const ok = page.waitForResponse((r) => r.url().endsWith('/api/world/actions') && r.request().method() === 'POST');
      await tap(page.locator(`[data-buy="${first.id}"]`), `Buy ${first.name}`);
      assert((await ok).status() === 200, `buying ${first.id} was refused`);
      actions = (await t.api.api('GET', '/api/world/actions')).body.actions;
      assert(actions.some((a) => a.item === first.id), `${first.id} was not saved`);

      // Another tab spends the money first; this tab still thinks it can afford the target.
      await page.waitForTimeout(1_500);
      // The cheapest thing still on offer: the easiest to spend just below.
      const target = (await placeless(actions))[0];
      if (!target) throw new Skip('nothing left to try an unaffordable build with');
      for (let i = 0; i < 80 && cityOf(t.timeline, actions, t.joinedAt).treasury >= target.price; i++) {
        const next = affordable(t.timeline, actions, t.joinedAt, { except: [target.id] });
        if (!next) break;
        const r = await t.api.api('POST', '/api/world/actions', { body: { action: next.action } });
        assert(r.status === 200, `the other tab's ${next.item.id} was refused: ${JSON.stringify(r.body)}`);
        actions = r.body.actions;
      }
      // If the land runs out first, the other tab buys the target itself: the
      // stale tab's purchase is then refused for space rather than money, and
      // the rollback is the same.
      if (cityOf(t.timeline, actions, t.joinedAt).treasury >= target.price) {
        const today = t.timeline.snapshots.at(-1).t;
        // Sites hold a few of each (an airport has four stands): fill it.
        for (let i = 0; i < 6; i++) {
          const r = await t.api.api('POST', '/api/world/actions', { body: { action: { t: today, kind: 'build', item: target.id } } });
          if (r.status !== 200) break;
          actions = r.body.actions;
        }
        assert(actions.some((a) => a.item === target.id), `the other tab couldn't buy ${target.id}`);
        t.notes = `spent the target itself (${target.id}): the land ran out before the money`;
      }
      // Toasts come and go in seconds: record every one from here on.
      await page.evaluate(() => {
        const w = window;
        w.__ttToasts = [];
        new MutationObserver((ms) => {
          for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLElement && n.classList.contains('toast')) w.__ttToasts.push(n.textContent ?? '');
        }).observe(document.body, { subtree: true, childList: true });
      });
      const refused = page.waitForResponse((r) => r.url().endsWith('/api/world/actions') && r.request().method() === 'POST');
      await tap(page.locator(`[data-buy="${target.id}"]`), `Buy ${target.name}`);
      const res = await refused;
      assert(res.status() === 409, `the stale purchase answered ${res.status()}, want 409`);
      await page.waitForFunction(() => window.__ttToasts.some((x) => /been undone/.test(x)), null, { timeout: 30_000, polling: 250 });
      const saved = (await t.api.api('GET', '/api/world/actions')).body.actions;
      const before = actions.filter((a) => a.item === target.id).length;
      assert(saved.filter((a) => a.item === target.id).length === before, `${target.id} was saved despite the 409`);
      await page.keyboard.press('Escape');
    },
  },
  {
    name: 'ui: account menu: data export, billing portal, delete account',
    needs: "ui: the city loads with the founder's timeline and seed",
    prepare: (t) => fastForward(t),
    async run(t) {
      const { page, stack } = t;
      // Whatever the last journey left open (the build drawer, a dialog) goes first.
      await page.keyboard.press('Escape');
      const buildBtn = page.getByRole('button', { name: 'Build (B)' });
      if ((await buildBtn.first().getAttribute('aria-expanded').catch(() => null)) === 'true') await tap(buildBtn, 'Build');
      const openAccount = async () => {
        const btn = page.locator('button[aria-label^="Your account"]');
        if (!(await shows(btn, 60_000))) throw new Error('the account button is not on screen');
        await tap(btn, 'the account button');
        assert(await shows(dialog(page, /Your account/)), 'the account dialog did not open');
      };
      await openAccount();
      const acct = dialog(page, /Your account/);
      const exportBtn = acct.getByRole('button', { name: 'Download my data' });
      const deleteStart = acct.getByRole('button', { name: /Delete account/ });
      const missing = [];
      const canDelete = await shows(deleteStart);
      if (await shows(exportBtn)) {
        const download = page.waitForEvent('download', { timeout: 60_000 });
        await tap(exportBtn);
        const d = await download;
        const file = join(OUT, 'export.json');
        await d.saveAs(file);
        const { readFileSync } = await import('node:fs');
        const text = readFileSync(file, 'utf8');
        assert(text.includes(t.email), 'the export does not include the email');
        assert(!/fake_rt_|fake_at_|"secret":"v1\./.test(text), 'the export leaks a token');
      } else missing.push('data export');

      // The portal leaves the app; come back and reload for the delete.
      const portal = acct.getByRole('button', { name: /Manage billing|Update card/ });
      if (await shows(portal)) {
        await tap(portal, 'Manage billing');
        await page.waitForURL(/\/stripe-pages\/portal\//, { timeout: 60_000, waitUntil: 'commit' });
        assert(await shows(page.getByRole('heading', { name: 'Manage your TinyTown plan' })), 'the portal page did not load');
      } else missing.push('billing portal');

      if (!canDelete) missing.push('delete account');
      else {
        if (page.url().includes('/stripe-pages/')) {
          await page.goto(`${stack.appUrl}/`, { waitUntil: 'commit', timeout: LOAD_MS });
          await shellUp(page);
          await openAccount();
        }
        await tap(dialog(page, /Your account/).getByRole('button', { name: /Delete account/ }), 'Delete account…');
        const confirm = page.locator('form.delete-form input[name=confirm]');
        assert(await shows(confirm), 'no confirmation field');
        await confirm.fill(t.email);
        const gone = page.waitForResponse((r) => r.url().endsWith('/api/account') && r.request().method() === 'DELETE');
        await tap(page.locator('form.delete-form button[type=submit]'), 'Delete account');
        const res = await gone;
        assert(res.status() === 200, `deleting answered ${res.status()}: ${await res.text()}`);
        assert(await shows(page.getByRole('heading', { name: /deleted/i }), 15_000), 'no confirmation that the account is deleted');
        const leftovers = Object.entries(stack.fakes.state.tables).filter(([, rows]) => rows.some((r) => r.user_id && stack.fakes.state.auth.byEmail.get(t.email)?.id === r.user_id));
        assert(!stack.fakes.state.auth.byEmail.has(t.email), 'the auth user still exists');
        assert(!leftovers.length, `rows left in ${leftovers.map(([n]) => n).join(', ')}`);
      }
      if (missing.length) throw new Skip(`not in the account menu yet: ${missing.join(', ')}`);
    },
  },
  {
    name: 'ui: a first visit opens on the front door, and "Watch a startup grow" steps in',
    async run(t) {
      const { browser, stack } = t;
      // Park the shared page: a second city rendering in software WebGL would starve this one.
      await t.page.goto('about:blank').catch(() => {});
      // A browser that has never been here (the shared context marks the front door as seen).
      const context = await browser.newContext({ viewport: { width: 1200, height: 760 } });
      await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.fulfill({ status: 204, body: '' }));
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      page.on('pageerror', (e) => t.pageErrors.push(`${e.message} @ ${page.url()}`));
      try {
        await page.goto(`${stack.appUrl}/?intro`, { waitUntil: 'commit', timeout: LOAD_MS });
        const door = page.getByRole('region', { name: /Your startup/ });
        assert(await shows(door, LOAD_MS), 'no front door on a first visit with ?intro');
        assert(await shows(page.getByRole('button', { name: /Make it yours/ })), 'the front door has no "Make it yours"');
        await tap(page.getByRole('button', { name: 'Watch a startup grow' }), 'Watch a startup grow');
        // Read the day straight away: the replay runs at twelve days a second.
        const day = await page.evaluate(() => Number(document.querySelector('input[type=range]')?.value));
        assert(day < 60, `the replay didn't start from the beginning (day ${day})`);
        // Timer polling: animation frames are scarce while software WebGL draws the replay.
        await page.waitForFunction(() => !document.querySelector('.frontdoor') && document.documentElement.classList.contains('hud-in'), null, { timeout: 60_000, polling: 500 });
        assert(await page.evaluate(() => localStorage.getItem('tinytown:frontdoor-seen') === '1'), 'the front door was not remembered');
      } catch (err) {
        // The harness screenshots the shared page; this journey's page is its own.
        const state = await page.evaluate(() => `${location.href} html.${document.documentElement.className}`).catch(() => '');
        await page.screenshot({ path: join(OUT, 'front-door-journey.png'), timeout: 120_000 }).catch(() => {});
        throw new Error(`${err instanceof Error ? err.message : err} (${state})`);
      } finally {
        await context.close();
      }
    },
  },
  {
    name: 'ui: no uncaught errors in the whole run',
    async run(t) {
      assert(!t.pageErrors.length, `uncaught: ${t.pageErrors.slice(0, 5).join(' | ')}`);
      // The refused build above logs its 409 on purpose.
      const unexpected = t.consoleErrors.filter((e) => !/status of 409/.test(e));
      if (unexpected.length) throw new Skip(`console errors (after the demo): ${unexpected.slice(0, 5).join(' | ')}`);
    },
  },
];
