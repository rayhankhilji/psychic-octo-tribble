/**
 * The overview: the numbers the owner checks every morning of the launch.
 * Every figure is a count from the database (or the nightly product_daily
 * table, which says so); nothing is estimated.
 */
import type { Overview } from './types.ts';
import { ICON, ago, esc, money, n, pct, sparkline, timeOf } from './ui.ts';
import { failure, skeleton, type View } from './view.ts';

export async function overviewPage(v: View) {
  v.title('Overview');
  skeleton(v.root);
  let o: Overview;
  try {
    o = await v.api.overview();
  } catch (err) {
    if (!v.stale()) failure(v.root, err);
    return;
  }
  if (v.stale()) return;
  v.stamp(`Counted ${timeOf(o.generatedAt)}`);
  v.root.innerHTML = render(o);
}

function signed(x: number): string {
  return x > 0 ? `+${n(x)}` : x < 0 ? `−${n(-x)}` : '0';
}

function render(o: Overview): string {
  const w = o.waitlist;
  const series = o.series;
  const mv = o.movement;
  const tiles = `
    <div class="grid kpis">
      <div class="card tile">
        <div class="tile-label">MRR</div>
        <div class="tile-value">${o.mrr ? money(o.mrr.amount, o.mrr.currency) : '–'}</div>
        <div class="tile-sub">${o.mrr ? `Stripe plans at today's prices. Comps excluded.` : 'Billing isn’t set up on this server.'}</div>
        ${sparkline(series.map((s) => s.mrr))}
      </div>
      <div class="card tile">
        <div class="tile-label">Paying founders</div>
        <div class="tile-value">${n(o.paying.total - o.paying.comp)}${o.paying.comp ? `<small>+ ${n(o.paying.comp)} comped</small>` : ''}</div>
        <div class="tile-sub">${mv ? `<span class="delta ${mv.d1.started ? 'up' : ''}">+${n(mv.d1.started)}</span> today · <b>${n(mv.d7.ended)}</b> ended this week` : 'No plan history yet.'}</div>
        ${sparkline(series.map((s) => s.paying))}
      </div>
      <div class="card tile">
        <div class="tile-label">Accounts</div>
        <div class="tile-value">${n(o.accounts.total)}</div>
        <div class="tile-sub"><span class="delta ${o.accounts.d1 ? 'up' : ''}">+${n(o.accounts.d1)}</span> today · <b>+${n(o.accounts.d7)}</b> this week</div>
        ${sparkline(series.map((s) => s.accounts))}
      </div>
      <div class="card tile">
        <div class="tile-label">Waitlist let in</div>
        ${
          w
            ? `<div class="tile-value">${n(w.invited)}<small>of ${n(w.total)}</small></div>
               <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${w.total}" aria-valuenow="${w.invited}" aria-label="Invited"><i style="width:${w.total ? (w.invited / w.total) * 100 : 0}%"></i></div>
               <div class="tile-sub">${w.lastWave != null ? `Wave ${w.lastWave} · ` : ''}<b>${n(w.waiting)}</b> still waiting</div>`
            : `<div class="tile-value">–</div><div class="tile-sub">The waitlist table isn't there yet (migration 0004).</div>`
        }
      </div>
    </div>`;

  const steps = w
    ? [
        ['On the list', w.total, null],
        ['Invited', w.invited, w.total],
        ['Signed up', w.signedUp, w.invited],
        ['Paying', w.paid, w.signedUp],
      ]
    : [];
  const funnel = `
    <section class="card">
      <div class="card-head"><h2>Waitlist funnel</h2><span class="aside">Each step as a share of the one before</span></div>
      <div class="card-body">
        ${
          w
            ? `<div class="funnel">${steps
                .map(
                  ([label, value, of]) => `
                <div class="funnel-row">
                  <span class="label">${label}</span>
                  <div class="bar" aria-hidden="true"><i style="width:${w.total ? ((value as number) / w.total) * 100 : 0}%"></i></div>
                  <span class="value">${n(value as number)}<span class="muted">${of == null ? '' : pct(value as number, of as number)}</span></span>
                </div>`,
                )
                .join('')}</div>
              ${w.unnotified ? `<p class="note" style="margin:14px 0 0">${n(w.unnotified)} invited ${w.unnotified === 1 ? 'person has' : 'people have'} no invite email on record. Send them from <a href="#/waitlist">Waitlist</a>.</p>` : ''}`
            : '<div class="empty">No waitlist yet.</div>'
        }
      </div>
    </section>`;

  const rows = mv
    ? ([
        ['Last 24 hours', mv.d1, o.accounts.d1],
        ['Last 7 days', mv.d7, o.accounts.d7],
        ['Last 30 days', mv.d30, o.accounts.d30],
      ] as const)
    : [];
  const movement = `
    <section class="card">
      <div class="card-head"><h2>Movement</h2><span class="aside">${o.source === 'product_daily' ? 'From the nightly product_daily table' : 'Counted live'}</span></div>
      <div class="card-body" style="padding:6px 0 4px">
        ${
          mv
            ? `<div class="table-wrap"><table>
                <thead><tr><th>Period</th><th class="r">Accounts</th><th class="r">Plans started</th><th class="r">Ended</th><th class="r">Net</th></tr></thead>
                <tbody>${rows
                  .map(
                    ([label, m, acc]) => `<tr><td>${label}</td><td class="r num">${n(acc)}</td><td class="r num">${n(m.started)}</td><td class="r num">${n(m.ended)}</td>
                    <td class="r num"><span class="delta ${m.started - m.ended > 0 ? 'up' : m.started - m.ended < 0 ? 'down' : ''}">${signed(m.started - m.ended)}</span></td></tr>`,
                  )
                  .join('')}</tbody></table></div>`
            : '<div class="empty">Plan history starts recording once migration 0004 is applied.</div>'
        }
      </div>
    </section>`;

  const c = o.connections;
  const connections = `
    <section class="card">
      <div class="card-head"><h2>Connections</h2>
        <span class="aside">${c.stripe.broken ? `<span class="status bad">${ICON.alert}${n(c.stripe.broken)} need reconnecting</span>` : `<span class="status good">${ICON.check}All healthy</span>`}</span>
      </div>
      <div class="card-body">
        <dl class="kv">
          <dt>Stripe</dt><dd><b class="num">${n(c.stripe.total)}</b> <span class="muted">· ${n(c.stripe.live)} live, ${n(c.stripe.test)} test</span></dd>
          <dt>GitHub</dt><dd><b class="num">${n(c.github.total)}</b> <span class="muted">· ${n(c.github.noRepo)} without a repository chosen</span></dd>
          <dt>PostHog</dt><dd><b class="num">${n(c.posthog)}</b></dd>
        </dl>
        ${
          c.broken.length
            ? `<div class="table-wrap" style="margin:12px -16px -16px;border-top:1px solid var(--line)"><table><tbody>${c.broken
                .map((b) => `<tr class="link" data-href="#/users/${esc(b.userId)}"><td><span class="status bad">${ICON.unlink}${esc(b.reason)}</span></td><td class="mono muted">${esc(b.userId.slice(0, 8))}</td><td class="r"><a class="crumb" href="#/users/${esc(b.userId)}">Open founder ${ICON.chevronRight}</a></td></tr>`)
                .join('')}</tbody></table></div>`
            : ''
        }
      </div>
    </section>`;

  const p = o.paying;
  const real = p.total - p.comp;
  const plans = `
    <section class="card">
      <div class="card-head"><h2>Plans</h2><span class="aside">${n(p.total)} with paid access</span></div>
      <div class="card-body" style="padding:6px 0 4px">
        <div class="table-wrap"><table><tbody>
          <tr><td>Monthly</td><td class="r num">${n(p.monthly)}</td><td class="r muted num">${pct(p.monthly, real)}</td></tr>
          <tr><td>Yearly</td><td class="r num">${n(p.yearly)}</td><td class="r muted num">${pct(p.yearly, real)}</td></tr>
          <tr><td>Comped <span class="sub">· no Stripe, not revenue</span></td><td class="r num">${n(p.comp)}</td><td class="r muted num"></td></tr>
          <tr><td><span class="status warn">${ICON.alert}Past due</span></td><td class="r num">${n(p.pastDue)}</td><td class="r muted num">${pct(p.pastDue, real)}</td></tr>
          <tr><td>Cancelling at period end</td><td class="r num">${n(p.cancelling)}</td><td class="r muted num">${pct(p.cancelling, real)}</td></tr>
        </tbody></table></div>
      </div>
    </section>`;

  return `
    ${tiles}
    <div class="grid cols-2 section">${funnel}${movement}</div>
    <div class="grid cols-2 section">${connections}${plans}</div>
    <p class="note section">Access is <b>${o.access === 'waitlist' ? 'by invite (waitlist mode)' : 'open to everyone'}</b>. Counted ${ago(o.generatedAt)}; reload for fresh numbers.</p>`;
}
