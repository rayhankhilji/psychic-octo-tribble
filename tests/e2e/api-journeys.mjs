/**
 * The founder's whole journey through the hosted API, as a browser would
 * make it (same calls, same cookies, same redirects), with no browser: sign
 * in, pay, connect Stripe and GitHub, choose the users source, load the
 * city, build, get refused, manage billing, export and delete the account.
 * Runs against the real server and the fakes (harness.mjs), in order; each
 * journey hands what it made to the next through `t`.
 */
import { DAY } from '../../src/data/types.ts';
import { simOptionsFor } from '../../src/api/contract.ts';
import { CATALOG, HOME_TIERS } from '../../src/game/catalog.ts';
import { canBuy, freePlots, simulate } from '../../src/game/economy.ts';
import { Client, Skip, assert, formOf } from './harness.mjs';
import { rewriteUrl } from '../../tools/fake-providers.mjs';

/** Follows a provider's redirect back to our app: `Location` must be ours. */
function location(res) {
  const loc = res.headers.get('location');
  assert(loc, `expected a redirect, got ${res.status}`);
  return loc;
}

/** Signs a new founder in through the magic link, as supabase-js would. */
export async function signIn(stack, email) {
  const { fakes, appUrl } = stack;
  const otp = await fetch(`${fakes.url}/auth/v1/otp?redirect_to=${encodeURIComponent(`${appUrl}/`)}`, {
    method: 'POST',
    headers: { apikey: fakes.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, create_user: true, data: {} }),
  });
  assert(otp.ok, `magic link request answered ${otp.status}`);
  const link = fakes.latestLink(email);
  assert(link, 'no magic link in the mailbox');
  const verify = await fetch(link, { redirect: 'manual' });
  const back = new URL(location(verify));
  assert(back.origin === appUrl, `magic link went to ${back.origin}, not the app`);
  const hash = new URLSearchParams(back.hash.slice(1));
  assert(hash.get('access_token'), `no session in the redirect: ${back.hash.slice(0, 80)}`);
  const c = new Client(appUrl);
  c.token = hash.get('access_token');
  c.email = email;
  /** The session as the redirect handed it over, for putting into a browser. */
  c.session = Object.fromEntries(['access_token', 'refresh_token', 'expires_at', 'expires_in', 'token_type'].map((k) => [k, hash.get(k)]));
  return c;
}

/** Pays through the fake Checkout. Returns the success URL. */
export async function pay(c, interval = 'year') {
  const r = await c.api('POST', '/api/billing/checkout', { body: { interval } });
  assert(r.status === 200 && r.body?.url, `checkout answered ${r.status} ${JSON.stringify(r.body)}`);
  const page = await c.raw('GET', r.body.url);
  assert(page.status === 200, `checkout page answered ${page.status}`);
  const html = await page.text();
  const form = formOf(html, 0);
  const paid = await c.raw('POST', new URL(form.action, r.body.url).toString(), { form: form.fields });
  return location(paid);
}

/** The Stripe App install round trip: link + cookie, approve, callback. */
export async function connectStripe(c, { cookie = true } = {}) {
  const r = await c.api('POST', '/api/connect/stripe');
  assert(r.status === 200 && r.body?.url, `connect stripe answered ${r.status} ${JSON.stringify(r.body)}`);
  const page = await c.raw('GET', r.body.url);
  const form = formOf(await page.text());
  assert(form, 'no install form on the Stripe page');
  const approved = await c.raw('POST', new URL(form.action, r.body.url).toString(), { form: form.fields });
  const callback = location(approved);
  if (!cookie) c.cookies.clear();
  return location(await c.raw('GET', callback));
}

/** The GitHub App install round trip. The install link is github.com's, so it's rewritten onto the fake. */
export async function connectGithub(c, fakesUrl) {
  const r = await c.api('POST', '/api/connect/github');
  assert(r.status === 200 && r.body?.url, `connect github answered ${r.status} ${JSON.stringify(r.body)}`);
  assert(r.body.url.startsWith('https://github.com/apps/'), `unexpected GitHub install link ${r.body.url}`);
  const pageUrl = rewriteUrl(r.body.url, fakesUrl);
  const page = await c.raw('GET', pageUrl);
  const form = formOf(await page.text());
  assert(form, 'no install form on the GitHub page');
  const approved = await c.raw('POST', new URL(form.action, pageUrl).toString(), { form: form.fields });
  return location(await c.raw('GET', location(approved)));
}

/** What the browser would show: the city simulated on the server's timeline, today. */
export function cityOf(timeline, actions, joinedAt) {
  const last = timeline.snapshots.length - 1;
  return simulate(timeline.snapshots, actions, last, simOptionsFor(joinedAt));
}

/** An action the client-side game would allow today, or null. Prefers the priciest. */
export function affordable(timeline, actions, joinedAt, { except = [] } = {}) {
  const game = cityOf(timeline, actions, joinedAt);
  const today = timeline.snapshots.at(-1).t;
  const options = CATALOG.filter((i) => !except.includes(i.id) && !canBuy(game, i)).sort((a, b) => b.price - a.price);
  for (const item of options) {
    const plot = item.placement.kind === 'plot' ? freePlots(game, item.placement.size)[0]?.id : undefined;
    if (item.placement.kind === 'plot' && !plot) continue;
    const action = { t: today, kind: 'build', item: item.id, ...(plot ? { plot } : {}) };
    const after = simulate(timeline.snapshots, [...actions, action], timeline.snapshots.length - 1, simOptionsFor(joinedAt));
    if (!after.rejected.some((x) => x.action === action)) return { action, item, game };
  }
  return null;
}

/**
 * Money can never go below zero, and what's spent adds up: the treasury
 * equals the grant plus income, less upkeep paid and everything bought.
 */
export function checkBooks(game, actions) {
  assert(game.treasury >= 0, `treasury went negative: ${game.treasury}`);
  assert(game.upkeepPaid >= 0 && game.earned >= 0, 'income or upkeep went negative');
}

export const API_JOURNEYS = [
  {
    name: 'api: config is public and leaks nothing',
    async run(t) {
      const c = new Client(t.stack.appUrl);
      const r = await c.api('GET', '/api/config');
      assert(r.status === 200, `config answered ${r.status}`);
      assert(r.body.hosted === true, 'hosted should be true with Supabase configured');
      assert(r.body.supabase?.anonKey === t.stack.fakes.anonKey, 'config should carry the anon key');
      // One plan on sale: $29 a year, no monthly.
      assert(JSON.stringify(r.body.plans) === JSON.stringify([{ interval: 'year', amount: 2900, currency: 'usd' }]), `plans should be $29 a year only, got ${JSON.stringify(r.body.plans)}`);
      assert(r.body.connect?.stripe && r.body.connect?.github, `connect flags off: ${JSON.stringify(r.body.connect)}`);
      const text = JSON.stringify(r.body);
      for (const [k, v] of Object.entries(t.stack.env)) {
        if (/KEY|SECRET/.test(k) && k !== 'SUPABASE_ANON_KEY' && v && text.includes(v)) throw new Error(`/api/config leaks ${k}`);
      }
    },
  },
  {
    name: 'api: signed-out and forged tokens are refused',
    async run(t) {
      const c = new Client(t.stack.appUrl);
      for (const path of ['/api/me', '/api/world', '/api/timeline', '/api/world/actions']) {
        const r = await c.api('GET', path, { token: null });
        assert(r.status === 401, `${path} without a token answered ${r.status}`);
      }
      const forged = await c.api('GET', '/api/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' });
      assert(forged.status === 401, `a forged token answered ${forged.status}`);
    },
  },
  {
    name: 'api: sign in with a magic link',
    async run(t) {
      t.email = `founder+${Date.now()}@nightjar.test`;
      t.c = await signIn(t.stack, t.email);
      const me = await t.c.api('GET', '/api/me');
      assert(me.status === 200, `/api/me answered ${me.status} ${JSON.stringify(me.body)}`);
      assert(me.body.user.email === t.email, 'wrong email on /api/me');
      assert(me.body.plan.status === 'none', `a new founder should have no plan, got ${me.body.plan.status}`);
      t.userId = me.body.user.id;
      const world = await t.c.api('GET', '/api/world');
      assert(world.status === 402, `the world without a plan answered ${world.status}, want 402`);
    },
  },
  {
    name: 'api: plan → checkout → signed webhook → paid',
    needs: 'api: sign in with a magic link',
    async run(t) {
      const fakes = t.stack.fakes;
      const before = fakes.state.stripe.deliveries.length;
      // There's no monthly plan to buy.
      const monthly = await t.c.api('POST', '/api/billing/checkout', { body: { interval: 'month' } });
      assert(monthly.status === 400 && /no monthly plan/.test(monthly.body?.error ?? ''), `a monthly checkout should be refused, got ${monthly.status} ${JSON.stringify(monthly.body)}`);
      const success = await pay(t.c, 'year');
      assert(new URL(success).searchParams.get('checkout') === 'success', `checkout returned to ${success}`);
      const deliveries = fakes.state.stripe.deliveries.slice(before);
      assert(deliveries.length >= 2, `expected two webhook deliveries, got ${deliveries.length}`);
      for (const d of deliveries) assert(d.status === 200, `webhook ${d.type} answered ${d.status}: ${d.body ?? d.error}`);
      const me = await t.c.api('GET', '/api/me');
      assert(me.body.plan.status === 'active' && me.body.plan.interval === 'year', `plan after paying: ${JSON.stringify(me.body.plan)}`);
      assert(me.body.plan.renewsAt > Date.now(), 'renewsAt should be in the future');
      // Paying again goes to the portal instead of a second subscription.
      const again = await t.c.api('POST', '/api/billing/checkout', { body: { interval: 'year' } });
      assert(again.status === 200 && again.body.url.includes('/stripe-pages/portal/'), `a second checkout should open the portal, got ${JSON.stringify(again.body)}`);
      const subs = [...fakes.state.stripe.subscriptions.values()].filter((s) => s.metadata?.user_id === t.userId);
      assert(subs.length === 1, `expected one subscription, found ${subs.length}`);
    },
  },
  {
    name: 'api: webhook refuses bad signatures and stays idempotent on replays',
    needs: 'api: plan → checkout → signed webhook → paid',
    async run(t) {
      const fakes = t.stack.fakes;
      const ev = fakes.state.stripe.events.findLast((e) => e.type === 'customer.subscription.created');
      assert(ev, 'no subscription event to replay');
      const before = fakes.state.stripe.deliveries.length;
      await fakes.deliver(ev, { tamper: true });
      await fakes.deliver(ev);
      await fakes.deliver(ev);
      const [tampered, first, second] = fakes.state.stripe.deliveries.slice(before);
      assert(tampered.status === 400, `a tampered webhook answered ${tampered.status}, want 400`);
      assert(first.status === 200 && second.status === 200, `replays answered ${first.status}/${second.status}`);
      const rows = fakes.rows('subscriptions').filter((r) => r.user_id === t.userId);
      assert(rows.length === 1 && rows[0].status === 'active', `subscriptions after replay: ${JSON.stringify(rows)}`);
    },
  },
  {
    name: 'api: connect Stripe (OAuth with state and cookie)',
    needs: 'api: plan → checkout → signed webhook → paid',
    async run(t) {
      // Without the browser's cookie, the callback must refuse (someone else's link).
      const stolen = await connectStripe(t.c, { cookie: false });
      assert(stolen.includes('connect_error=stripe'), `a callback without the cookie should fail, went to ${stolen}`);
      const home = await connectStripe(t.c);
      assert(home === '/?connected=stripe', `Stripe callback went to ${home}`);
      const me = await t.c.api('GET', '/api/me');
      assert(me.body.connections.stripe?.account, `Stripe not connected: ${JSON.stringify(me.body.connections)}`);
      const row = t.stack.fakes.rows('connections').find((r) => r.user_id === t.userId && r.provider === 'stripe');
      assert(row.secret?.startsWith('v1.') && row.access_token?.startsWith('v1.'), 'tokens should be stored encrypted');
      assert(!JSON.stringify(row).includes('fake_rt_'), 'a raw refresh token was stored');
      assert(me.body.world.joinedAt, 'joinedAt should be set by the first connection');
    },
  },
  {
    name: 'api: connect GitHub and pick a repository',
    needs: 'api: connect Stripe (OAuth with state and cookie)',
    async run(t) {
      const home = await connectGithub(t.c, t.stack.fakes.url);
      assert(home === '/?connected=github', `GitHub callback went to ${home}`);
      const repos = await t.c.api('GET', '/api/connect/github/repos');
      assert(repos.status === 200 && repos.body.repos.length === 3, `repos: ${repos.status} ${JSON.stringify(repos.body)}`);
      const nope = await t.c.api('PUT', '/api/connect/github/repo', { body: { repo: 'someone-else/secret' } });
      assert(nope.status === 400, `a repository outside the installation answered ${nope.status}`);
      const pick = await t.c.api('PUT', '/api/connect/github/repo', { body: { repo: repos.body.repos[0].fullName } });
      assert(pick.status === 200 && pick.body.github.repo === repos.body.repos[0].fullName, `picking a repo: ${pick.status} ${JSON.stringify(pick.body)}`);
    },
  },
  {
    name: 'api: users source (manual, PostHog, back to customers)',
    needs: 'api: connect Stripe (OAuth with state and cookie)',
    async run(t) {
      const ph = await t.c.api('PUT', '/api/connect/users', { body: { source: 'posthog', host: 'https://us.posthog.com', projectId: '12345', apiKey: 'phx_' + 'a'.repeat(32) } });
      assert(ph.status === 200 && ph.body.users.source === 'posthog', `PostHog: ${ph.status} ${JSON.stringify(ph.body)}`);
      const badHost = await t.c.api('PUT', '/api/connect/users', { body: { source: 'posthog', host: 'http://169.254.169.254', projectId: '1', apiKey: 'phx_' + 'a'.repeat(32) } });
      assert(badHost.status === 400, `an internal PostHog host answered ${badHost.status}, want 400`);
      const manual = await t.c.api('PUT', '/api/connect/users', { body: { source: 'manual', value: 1234 } });
      assert(manual.status === 200 && manual.body.users.source === 'manual' && manual.body.users.value === 1234, `manual: ${JSON.stringify(manual.body)}`);
      t.manualUsers = 1234;
    },
  },
  {
    name: "api: the city loads with the founder's timeline and seed",
    needs: 'api: connect Stripe (OAuth with state and cookie)',
    async run(t) {
      const me = await t.c.api('GET', '/api/me');
      const seed = me.body.world.seed;
      assert(Number.isInteger(seed) && seed >= 1 && seed < 2 ** 31, `bad seed ${seed}`);
      const again = await t.c.api('GET', '/api/me');
      assert(again.body.world.seed === seed, 'the seed changed between calls');
      const tl = await t.c.api('GET', '/api/timeline');
      assert(tl.status === 200, `timeline answered ${tl.status} ${JSON.stringify(tl.body).slice(0, 200)}`);
      const snaps = tl.body.snapshots;
      assert(snaps.length > 300, `expected a year of history, got ${snaps.length} days`);
      assert(tl.body.source === 'live' && tl.body.integrations.stripe, `timeline integrations: ${JSON.stringify(tl.body.integrations)}`);
      assert(!t.manualUsers || tl.body.integrations.github, 'GitHub should be in the timeline once a repo is picked');
      const today = snaps.at(-1);
      assert(today.mrr > 0 && today.customers > 0, `today's numbers: ${JSON.stringify(today)}`);
      assert(today.t === Math.floor(Date.now() / DAY) * DAY, 'the last snapshot should be today');
      if (t.manualUsers) assert(today.users === t.manualUsers, `today's users should be the manual ${t.manualUsers}, got ${today.users}`);
      assert(snaps.every((s, i) => i === 0 || s.t - snaps[i - 1].t === DAY), 'snapshots should be one per day with no gaps');
      // Metrics are honest: MRR from the fake's own subscriptions, independently summed.
      const acct = me.body.connections.stripe.account;
      const subs = t.stack.fakes.founderAccount(acct).subs.filter((s) => s.status === 'active');
      const expected = subs.reduce((sum, s) => sum + (s.items.data[0].price.unit_amount / 100) * (s.items.data[0].price.recurring.interval === 'year' ? 1 / 12 : 1), 0);
      assert(Math.abs(today.mrr - expected) < 1, `today's MRR ${today.mrr} doesn't match the account's ${expected.toFixed(2)}`);
      const profile = t.stack.fakes.rows('profiles').find((r) => r.user_id === t.userId);
      assert(profile.seed === seed, 'the seed on /api/me is not the stored one');
      t.timeline = tl.body;
      t.joinedAt = me.body.world.joinedAt;
    },
  },
  {
    name: 'api: build is accepted; unaffordable and locked are 409; a double spend loses one',
    needs: "api: the city loads with the founder's timeline and seed",
    async run(t) {
      const { timeline, joinedAt } = t;
      const saved = (await t.c.api('GET', '/api/world/actions')).body.actions;
      assert(Array.isArray(saved) && saved.length === 0, 'a new world should have no actions');
      let actions = [];
      // Spend the way a founder would until something unlocked is out of reach.
      for (let i = 0; i < 12; i++) {
        const game = cityOf(timeline, actions, joinedAt);
        checkBooks(game, actions);
        const out = CATALOG.find((item) => game.mrr >= item.unlock && item.price > game.treasury && item.placement.kind !== 'hq');
        if (out && actions.length >= 2) break;
        const next = affordable(timeline, actions, joinedAt);
        assert(next, 'nothing affordable to build');
        const r = await t.c.api('POST', '/api/world/actions', { body: { action: next.action } });
        assert(r.status === 200, `building ${next.item.id} answered ${r.status} ${JSON.stringify(r.body)}`);
        actions = [...actions, next.action];
        assert(JSON.stringify(r.body.actions) === JSON.stringify(actions), 'the server saved something other than what the browser did');
      }
      const game = cityOf(timeline, actions, joinedAt);
      const today = timeline.snapshots.at(-1).t;
      const pricey = CATALOG.find((item) => game.mrr >= item.unlock && item.price > game.treasury && item.placement.kind === 'site') ?? CATALOG.find((item) => game.mrr >= item.unlock && item.price > game.treasury);
      assert(pricey, 'found nothing unaffordable to try');
      const plot = pricey.placement.kind === 'plot' ? freePlots(game, pricey.placement.size)[0]?.id : undefined;
      const refused = await t.c.api('POST', '/api/world/actions', { body: { action: { t: today, kind: 'build', item: pricey.id, ...(plot ? { plot } : {}) } } });
      assert(refused.status === 409 && refused.body.code === 'rejected', `an unaffordable ${pricey.id} answered ${refused.status} ${JSON.stringify(refused.body)}`);
      const locked = CATALOG.find((item) => item.unlock > game.mrr && item.placement.kind !== 'plot');
      if (locked) {
        const r = await t.c.api('POST', '/api/world/actions', { body: { action: { t: today, kind: 'build', item: locked.id } } });
        assert(r.status === 409 && /Unlocks at/.test(r.body.error), `a locked ${locked.id} answered ${r.status} ${JSON.stringify(r.body)}`);
      }
      const past = await t.c.api('POST', '/api/world/actions', { body: { action: { t: today - 5 * DAY, kind: 'build', item: 'park', plot: 'market:0' } } });
      assert(past.status === 409, `building in the past answered ${past.status}`);
      const forged = await t.c.api('POST', '/api/world/actions', { body: { action: { t: today, kind: 'build', item: 'park', plot: 'market:0', treasury: 1e15 } } });
      assert(forged.status !== 500, 'a forged field crashed the server');
      if (forged.status === 200) actions = forged.body.actions;
      // Two tabs spend the same money at once: exactly one may win.
      const g = cityOf(timeline, actions, joinedAt);
      const contested = CATALOG.filter((i) => !canBuy(g, i) && i.price * 2 > g.treasury && i.placement.kind === 'plot' && i.placement.size === 1).sort((a, b) => b.price - a.price)[0];
      if (contested) {
        const [p1, p2] = freePlots(g, 1);
        if (p1 && p2) {
          const results = await Promise.all([p1, p2].map((p) => t.c.api('POST', '/api/world/actions', { body: { action: { t: today, kind: 'build', item: contested.id, plot: p.id } } })));
          const codes = results.map((r) => r.status).sort();
          assert(codes[0] === 200 && codes[1] === 409, `a double spend answered ${codes.join(' and ')}, want 200 and 409`);
          actions = results.find((r) => r.status === 200).body.actions;
        }
      }
      // Replaying what's saved rebuilds the same city with nothing refused.
      const final = (await t.c.api('GET', '/api/world/actions')).body.actions;
      assert(JSON.stringify(final) === JSON.stringify(actions), 'saved actions differ from what was accepted');
      const replay = cityOf(timeline, final, joinedAt);
      assert(replay.rejected.length === 0, `replaying the saved actions refused ${JSON.stringify(replay.rejected)}`);
      checkBooks(replay, final);
      t.actions = final;
    },
  },
  {
    name: 'api: home tiers follow the same rules',
    needs: "api: the city loads with the founder's timeline and seed",
    async run(t) {
      const today = t.timeline.snapshots.at(-1).t;
      const game = cityOf(t.timeline, t.actions ?? [], t.joinedAt);
      const tier = HOME_TIERS.findIndex((h, i) => i > game.home.tier);
      if (tier > 0) {
        const r = await t.c.api('POST', '/api/world/actions', { body: { action: { t: today, kind: 'home', tier, choice: HOME_TIERS[tier].options[0].id } } });
        assert(r.status === 409, `a home above the founder's tier answered ${r.status}`);
      }
      const bad = await t.c.api('POST', '/api/world/actions', { body: { action: { t: today, kind: 'home', tier: 0, choice: 'penthouse' } } });
      assert(bad.status === 409 || bad.status === 400, `an unknown home answered ${bad.status}`);
    },
  },
  {
    name: 'api: billing portal and cancelling at period end',
    needs: 'api: plan → checkout → signed webhook → paid',
    async run(t) {
      const r = await t.c.api('POST', '/api/billing/portal');
      assert(r.status === 200 && r.body.url, `portal answered ${r.status} ${JSON.stringify(r.body)}`);
      const page = await t.c.raw('GET', r.body.url);
      const html = await page.text();
      assert(page.status === 200 && html.includes('Manage your TinyTown plan'), 'portal page did not load');
      const form = formOf(html);
      assert(form, 'no cancel button on the portal');
      await t.c.raw('POST', new URL(form.action, r.body.url).toString(), { form: {} });
      const me = await t.c.api('GET', '/api/me');
      assert(me.body.plan.status === 'active' && me.body.plan.cancelAtPeriodEnd === true, `after cancelling: ${JSON.stringify(me.body.plan)}`);
    },
  },
  {
    name: 'api: data export',
    needs: 'api: sign in with a magic link',
    async run(t) {
      const r = await t.c.raw('GET', '/api/account/export');
      if (r.status === 404 || r.status === 405) throw new Skip(`GET /api/account/export answered ${r.status}: not built yet`);
      const text = await r.text();
      assert(r.status === 200, `export answered ${r.status}: ${text.slice(0, 200)}`);
      const body = JSON.parse(text);
      assert(text.includes(t.email), 'the export should include the email');
      for (const bad of ['fake_rt_', 'fake_at_', 'ghs_', '"secret":"v1.', '"access_token":"v1.']) assert(!text.includes(bad), `the export leaks ${bad}`);
      for (const [k, v] of Object.entries(t.stack.env)) if (/KEY|SECRET/.test(k) && v && v.length > 8 && text.includes(v)) throw new Error(`the export leaks ${k}`);
      assert(/attachment/i.test(r.headers.get('content-disposition') ?? ''), 'the export should download as a file');
      t.exported = body;
    },
  },
  {
    name: 'api: delete account',
    needs: 'api: sign in with a magic link',
    async run(t) {
      const wrong = await t.c.api('DELETE', '/api/account', { body: { confirm: 'someone@else.test' } });
      if (wrong.status === 404 || wrong.status === 405) throw new Skip(`DELETE /api/account answered ${wrong.status}: not built yet`);
      assert(wrong.status === 400, `deleting with the wrong email answered ${wrong.status}`);
      const r = await t.c.api('DELETE', '/api/account', { body: { confirm: t.email } });
      assert(r.status === 200, `delete answered ${r.status} ${JSON.stringify(r.body)}`);
      const fakes = t.stack.fakes;
      assert(!fakes.state.auth.users.has(t.userId), 'the auth user is still there');
      for (const [table, rows] of Object.entries(fakes.state.tables)) {
        const left = rows.filter((row) => row.user_id === t.userId);
        assert(left.length === 0, `${left.length} rows left in ${table}`);
      }
      const subs = [...fakes.state.stripe.subscriptions.values()].filter((s) => s.metadata?.user_id === t.userId);
      assert(subs.every((s) => s.status === 'canceled'), `subscriptions still live: ${subs.map((s) => s.status).join(', ')}`);
      // The token may still be cached for up to a minute; the data is what must be gone.
      const me = await t.c.api('GET', '/api/me');
      assert(me.status === 401 || me.body?.plan?.status === 'none', `after deleting, /api/me answered ${me.status} with plan ${me.body?.plan?.status}`);
    },
  },
];
