/**
 * Finding a founder, and everything about one on a single page: plan,
 * connections (never their secrets), city, data, waitlist place, plan
 * history and what admins have done to the account. The actions here
 * (comp, revoke, refresh, resend) all go through the audit log.
 */
import type { UserDetail, UserSearch } from './types.ts';
import { ICON, ago, ask, busy, date, dateTime, esc, initial, money, n, planBadge, toast } from './ui.ts';
import { LABELS, READS } from './audit.ts';
import { failure, type View } from './view.ts';

let lastQuery = '';

export async function usersPage(v: View) {
  v.title('Users');
  v.root.innerHTML = `
    <label class="search" style="max-width:560px;margin:8px 0 16px"><span class="sr-only">Search users</span>${ICON.search}
      <input class="input" data-search type="search" placeholder="Email, user id, cus_… or acct_…" autocomplete="off" spellcheck="false" style="height:38px" value="${esc(lastQuery)}" /><kbd>/</kbd>
    </label>
    <div data-results><div class="skeleton" style="height:240px"></div></div>`;
  const input = v.root.querySelector<HTMLInputElement>('[data-search]')!;
  const out = v.root.querySelector<HTMLElement>('[data-results]')!;
  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    lastQuery = input.value.trim();
    try {
      const r = await v.api.search(lastQuery);
      if (mine === seq && !v.stale()) out.innerHTML = results(r);
    } catch (err) {
      if (mine === seq && !v.stale()) failure(out, err);
    }
  };
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 250);
  });
  input.addEventListener('keydown', (e) => {
    // Enter opens the first match.
    if (e.key === 'Enter') {
      const first = out.querySelector<HTMLAnchorElement>('tr.link a');
      if (first) location.hash = first.getAttribute('href')!;
    }
  });
  input.focus();
  await run();
}

function results(r: UserSearch): string {
  const users = r.users.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Email</th><th>Plan</th><th>Account made</th><th>Last sign-in</th><th>Id</th></tr></thead>
        <tbody>${r.users
          .map(
            (u) => `<tr class="link" data-href="#/users/${esc(u.id)}"><td><a href="#/users/${esc(u.id)}">${esc(u.email ?? '(no email)')}</a></td><td>${planBadge(u.plan, u.comp)}</td>
              <td class="num muted">${date(u.createdAt)}</td><td class="num muted">${ago(u.lastSignInAt)}</td><td class="mono muted">${esc(u.id.slice(0, 8))}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
    : `<div class="empty">${r.q ? `No accounts match “${esc(r.q)}”.` : 'No accounts yet.'}</div>`;
  const wait = r.waitlist.length
    ? `<section class="card section"><div class="card-head"><h2>On the waitlist</h2><span class="aside">Matching people without an account</span></div>
        <div class="card-body" style="padding:6px 0 4px"><div class="table-wrap"><table>
        <thead><tr><th>Email</th><th>Source</th><th>Joined list</th><th>Invited</th></tr></thead>
        <tbody>${r.waitlist.map((w) => `<tr><td>${esc(w.email)}</td><td class="muted">${esc(w.source)}</td><td class="num muted">${date(w.createdAt)}</td><td class="num">${w.invitedAt ? `${date(w.invitedAt)} · wave ${w.wave}` : '<span class="badge plain">Waiting</span>'}</td></tr>`).join('')}</tbody>
        </table></div></div></section>`
    : '';
  return `<section class="card"><div class="card-head" style="padding-bottom:10px"><h2>${r.q ? 'Accounts' : 'Newest accounts'}</h2><span class="aside">${n(r.users.length)} shown</span></div>${users}</section>${wait}`;
}

// ─── One founder ──────────────────────────────────────────────────────────

export async function userPage(v: View, id: string) {
  v.title('Founder', { label: 'Users', href: '#/users' });
  v.root.innerHTML = '<div class="skeleton" style="height:76px;margin:8px 0 20px"></div><div class="grid cols-2"><div class="skeleton" style="height:260px"></div><div class="skeleton" style="height:260px"></div></div>';
  const load = async () => {
    try {
      const d = await v.api.user(id);
      if (v.stale()) return;
      v.root.innerHTML = render(d, id);
      v.stamp(`Opened ${dateTime(Date.now())}`);
    } catch (err) {
      if (!v.stale()) failure(v.root, err);
    }
  };
  await load();

  v.root.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'comp') {
        const data = await ask({
          title: 'Comp a plan',
          body: 'Free paid access with no Stripe subscription, so they are never charged. It shows as comped here and isn’t counted as revenue.',
          fields: `
            <label class="field"><span>Reason (kept with the comp and in the audit log)</span><textarea class="input" name="reason" required minlength="3" maxlength="500" placeholder="Design partner for the launch"></textarea></label>`,
          confirm: 'Comp the plan',
          validate: (f) => (String(f.get('reason') ?? '').trim().length < 3 ? 'Say why, in a few words.' : null),
        });
        if (!data) return;
        await busy(btn, 'Comping…', () => v.api.comp(id, String(data.get('reason')).trim(), 'year'));
        toast('Plan comped. They have paid access now.');
      } else if (act === 'uncomp') {
        const data = await ask({
          title: 'Revoke the comp',
          body: 'Their plan ends now and TinyTown asks them to pick one. Their city and connections stay.',
          fields: '<label class="field"><span>Reason (optional)</span><textarea class="input" name="reason" maxlength="500"></textarea></label>',
          confirm: 'Revoke',
          danger: true,
        });
        if (!data) return;
        await busy(btn, 'Revoking…', () => v.api.uncomp(id, String(data.get('reason') ?? '').trim()));
        toast('Comp revoked.');
      } else if (act === 'refresh') {
        const r = await busy(btn, 'Rebuilding…', () => v.api.refresh(id));
        toast(r.ok ? `Rebuilt from their providers: ${n(r.days ?? 0)} days${r.mrr != null ? `, MRR ${money(Math.round(r.mrr * 100))}` : ''}.` : `The rebuild failed: ${r.error}`, r.ok ? 'ok' : 'bad');
      } else if (act === 'resend') {
        await busy(btn, 'Sending…', () => v.api.resendToUser(id));
        toast('Invite email sent again.');
      } else if (act === 'copy') {
        await navigator.clipboard?.writeText(btn.dataset.value ?? '');
        toast('Copied.');
        return;
      } else return;
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That didn’t work.', 'bad');
    }
  });
}

function section(title: string, aside: string, body: string): string {
  return `<section class="card"><div class="card-head"><h2>${title}</h2><span class="aside">${aside}</span></div><div class="card-body">${body}</div></section>`;
}

function render(d: UserDetail, id: string): string {
  const email = d.user?.email ?? null;
  const p = d.plan;
  const comped = !!p?.comp;
  const paid = !!p && ['active', 'trialing', 'past_due'].includes(p.status);

  const head = `
    <div class="person">
      <span class="avatar" aria-hidden="true">${initial(email)}</span>
      <div style="min-width:0">
        <h2>${esc(email ?? 'Account not found')}</h2>
        <div class="meta">
          ${planBadge(p?.status ?? 'none', comped)}
          ${d.profile ? `<span>${esc(d.profile.name)}</span>·` : ''}
          <button class="btn ghost sm mono" type="button" data-act="copy" data-value="${esc(id)}" title="Copy the user id">${esc(id)} ${ICON.copy}</button>
        </div>
      </div>
      <div class="actions">
        ${comped ? '<button class="btn danger" type="button" data-act="uncomp">Revoke comp</button>' : paid ? '' : `<button class="btn" type="button" data-act="comp">${ICON.sparkle}Comp a plan</button>`}
        ${d.profile ? `<button class="btn" type="button" data-act="refresh">${ICON.refresh}Refresh data</button>` : ''}
      </div>
    </div>`;

  const plan = section(
    'Plan',
    p?.livemode === false ? '<span class="badge warn">Test mode</span>' : '',
    p
      ? `<dl class="kv">
          <dt>Status</dt><dd>${planBadge(p.status, comped)}${p.cancelAtPeriodEnd ? ' <span class="badge warn">Cancels at period end</span>' : ''}</dd>
          <dt>Billing</dt><dd>${comped ? 'None (comped)' : p.interval === 'year' ? 'Yearly' : p.interval === 'month' ? 'Monthly' : '–'}</dd>
          <dt>${p.cancelAtPeriodEnd ? 'Ends' : 'Renews'}</dt><dd class="num">${date(p.renewsAt)}</dd>
          ${comped ? `<dt>Comped</dt><dd>${esc(p.comp!.reason)}<div class="muted">${esc(p.comp!.by ?? '')} · ${date(p.comp!.at)}</div></dd>` : ''}
          <dt>Stripe</dt><dd>${p.stripeCustomer ? `<a class="mono" href="https://dashboard.stripe.com/customers/${esc(p.stripeCustomer)}" target="_blank" rel="noopener">${esc(p.stripeCustomer)}</a>` : '<span class="muted">No customer</span>'}</dd>
        </dl>`
      : '<p class="muted" style="margin:0">No plan yet. They haven’t been to checkout.</p>',
  );

  const account = section(
    'Account',
    d.user?.providers.length ? esc(d.user.providers.join(', ')) : '',
    `<dl class="kv">
      <dt>Account made</dt><dd class="num">${dateTime(d.user?.createdAt)}</dd>
      <dt>Last sign-in</dt><dd class="num">${ago(d.user?.lastSignInAt)}</dd>
      <dt>Last city day seen</dt><dd class="num">${date(d.profile?.lastSeen)}</dd>
      <dt>Data joined</dt><dd class="num">${date(d.profile?.joinedAt)}</dd>
      <dt>Email</dt><dd>${d.user?.confirmed ? '<span class="status good">' + ICON.check + 'Confirmed</span>' : '<span class="muted">Not confirmed</span>'}</dd>
    </dl>`,
  );

  const conns = section(
    'Connections',
    `${n(d.connections.length)} connected`,
    d.connections.length
      ? `<div class="table-wrap" style="margin:-6px -16px -16px"><table><tbody>${d.connections
          .map(
            (c) => `<tr><td style="text-transform:capitalize"><b>${c.provider === 'github' ? 'GitHub' : c.provider === 'posthog' ? 'PostHog' : 'Stripe'}</b></td>
              <td class="wrap">${esc(c.name ?? c.detail ?? '')} <span class="mono muted">${esc(c.account)}</span>${c.livemode === false ? ' <span class="badge warn">Test</span>' : ''}</td>
              <td class="num muted">${date(c.connectedAt)}</td>
              <td>${c.health === 'ok' ? `<span class="status good">${ICON.check}Healthy</span>` : `<span class="status bad">${ICON.unlink}${esc(c.health)}</span>`}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : '<p class="muted" style="margin:0">Nothing connected yet.</p>',
  );

  const w = d.world;
  const t = d.timeline;
  const city = section(
    'City',
    t ? `Data fetched ${ago(t.fetchedAt)}` : '',
    `<dl class="kv">
      <dt>Actions</dt><dd class="num">${w ? `${n(w.actions)} <span class="muted">· ${n(w.built)} built, ${n(w.homeMoves)} house moves</span>` : '–'}</dd>
      <dt>Their MRR</dt><dd class="num">${t?.mrr != null ? money(Math.round(t.mrr * 100)) : '–'}${t?.customers != null ? ` <span class="muted">· ${n(t.customers)} customers</span>` : ''}</dd>
      <dt>History</dt><dd class="num">${t ? `${n(t.days)} days` : 'No data cached'}</dd>
    </dl>
    ${w?.recent.length ? `<ul class="feed" style="margin-top:10px">${w.recent.map((r) => `<li><span class="when">${date(r.t)}</span><span>${esc(r.what)}</span></li>`).join('')}</ul>` : ''}`,
  );

  const wl = d.waitlist;
  const wait = section(
    'Waitlist',
    wl ? esc(wl.source) : '',
    wl
      ? `<dl class="kv">
          <dt>Joined list</dt><dd class="num">${date(wl.createdAt)}</dd>
          <dt>Invited</dt><dd class="num">${wl.invitedAt ? `${date(wl.invitedAt)} · ${wl.wave === 0 ? 'hand-picked' : `wave ${wl.wave}`}` : '<span class="badge plain">Waiting</span>'}</dd>
          <dt>Invite email</dt><dd class="num">${wl.notifiedAt ? date(wl.notifiedAt) : wl.invitedAt ? '<span class="badge warn">Not sent</span>' : '–'}</dd>
          <dt>Signed up</dt><dd class="num">${date(wl.signedUpAt)}</dd>
        </dl>
        ${wl.invitedAt && !wl.signedUpAt ? `<div class="actions" style="margin-top:12px;margin-left:0"><button class="btn sm" type="button" data-act="resend">${ICON.mail}Resend invite</button></div>` : ''}`
      : '<p class="muted" style="margin:0">Not on the waitlist.</p>',
  );

  const history = section(
    'History',
    'Plan changes and admin actions',
    d.history.length || d.audit.some((a) => !READS.has(a.action))
      ? `<ul class="feed">${[
          ...d.history.map((h) => ({ at: h.at, text: `Plan ${h.change}${h.interval ? ` (${h.interval === 'year' ? 'yearly' : 'monthly'})` : ''}${h.comp ? ', comped' : ''}` })),
          ...d.audit.filter((a) => !READS.has(a.action)).map((a) => ({ at: a.at, text: `${esc(LABELS[a.action] ?? a.action)} <span class="muted">by ${esc(a.adminEmail)}</span>${a.status === 'error' ? ' <span class="badge bad">failed</span>' : ''}` })),
        ]
          .sort((a, b) => b.at - a.at)
          .slice(0, 20)
          .map((x) => `<li><span class="when">${date(x.at)}</span><span>${x.text}</span></li>`)
          .join('')}</ul>`
      : '<p class="muted" style="margin:0">Nothing yet.</p>',
  );

  return `${head}<div class="grid cols-2">${plan}${account}</div><div class="grid cols-2 section">${conns}${city}</div><div class="grid cols-2 section">${wait}${history}</div>`;
}
