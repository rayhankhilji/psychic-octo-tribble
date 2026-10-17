/**
 * The waitlist: let the next wave in, invite people by hand, and see how
 * each wave and source is doing. Big waves go up in batches of 500 (one
 * request each, each with its own request id), with progress shown, so a
 * closed tab or a dropped connection leaves a clean place to carry on from.
 */
import { requestId } from './api.ts';
import { INVITE_BATCH_MAX, type InviteResult, type WaitlistPage } from './types.ts';
import { ICON, busy, date, esc, n, pct, toast } from './ui.ts';
import { failure, skeleton, type View } from './view.ts';

interface State {
  status: string;
  q: string;
  source: string;
  offset: number;
}

const STATUSES: [string, string][] = [
  ['all', 'All'],
  ['waiting', 'Waiting'],
  ['invited', 'Invited'],
  ['joined', 'Signed up'],
];
const PRESETS = [500, 1500, 3000];

export async function waitlistPage(v: View) {
  v.title('Waitlist');
  skeleton(v.root);
  const state: State = { status: 'all', q: '', source: '', offset: 0 };
  let page: WaitlistPage;
  try {
    page = await v.api.waitlist(state);
  } catch (err) {
    if (!v.stale()) failure(v.root, err);
    return;
  }
  if (v.stale()) return;
  v.stamp(`${n(page.funnel.total)} on the list`);
  v.root.innerHTML = layout(page);
  const $ = <T extends Element>(sel: string) => v.root.querySelector<T>(sel)!;

  // ── The list ──
  let searchTimer = 0;
  const reload = async () => {
    try {
      page = await v.api.waitlist(state);
      if (v.stale()) return;
      $('[data-people]').innerHTML = people(page, state);
      $('[data-stats]').innerHTML = stats(page);
      const banner = $<HTMLElement>('[data-banner]');
      banner.innerHTML = unnotifiedBanner(page);
      banner.hidden = !page.funnel.unnotified;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load the list.', 'bad');
    }
  };
  v.root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const seg = t.closest<HTMLButtonElement>('[data-status]');
    if (seg) {
      state.status = seg.dataset.status!;
      state.offset = 0;
      for (const b of v.root.querySelectorAll<HTMLButtonElement>('[data-status]')) b.setAttribute('aria-pressed', String(b === seg));
      return reload();
    }
    const pageBtn = t.closest<HTMLButtonElement>('[data-page]');
    if (pageBtn) {
      state.offset = Math.max(0, state.offset + Number(pageBtn.dataset.page) * page.limit);
      return reload();
    }
    const resend = t.closest<HTMLButtonElement>('[data-resend]');
    if (resend) {
      await busy(resend, 'Sending…', async () => {
        try {
          await v.api.resend(resend.dataset.resend!);
          toast(`Invite sent again to ${resend.dataset.resend}.`);
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Could not resend.', 'bad');
        }
      });
      return;
    }
    if (t.closest('[data-notify-pending]')) {
      const btn = t.closest<HTMLButtonElement>('[data-notify-pending]')!;
      await busy(btn, 'Sending…', async () => {
        try {
          const r = await v.api.notifyPending();
          toast(`${n(r.sent)} invite ${r.sent === 1 ? 'email' : 'emails'} sent.`);
          await reload();
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Could not send.', 'bad');
        }
      });
    }
  });
  $<HTMLInputElement>('[data-search]').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.q = (e.target as HTMLInputElement).value.trim();
      state.offset = 0;
      void reload();
    }, 220);
  });
  $<HTMLSelectElement>('[data-filter-source]').addEventListener('change', (e) => {
    state.source = (e.target as HTMLSelectElement).value;
    state.offset = 0;
    void reload();
  });

  // ── Let the next wave in ──
  const count = $<HTMLInputElement>('[data-count]');
  const source = $<HTMLSelectElement>('[data-source]');
  const preview = $<HTMLElement>('[data-preview]');
  v.root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      count.value = b.dataset.preset === 'all' ? String(waitingIn(page, source.value)) : b.dataset.preset!;
      for (const x of v.root.querySelectorAll('[data-preset]')) x.setAttribute('aria-pressed', String(x === b));
      preview.hidden = true;
    }),
  );
  count.addEventListener('input', () => {
    preview.hidden = true;
    for (const x of v.root.querySelectorAll('[data-preset]')) x.setAttribute('aria-pressed', 'false');
  });
  source.addEventListener('change', () => (preview.hidden = true));

  $<HTMLFormElement>('[data-invite]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const want = Math.floor(Number(count.value));
    if (!(want >= 1)) return toast('Choose how many people to let in.', 'bad');
    const btn = $<HTMLButtonElement>('[data-invite] button[type=submit]');
    let peek: InviteResult;
    try {
      peek = await busy(btn, 'Checking…', () => v.api.previewInvite(want, source.value || null));
    } catch (err) {
      return toast(err instanceof Error ? err.message : 'Could not preview.', 'bad');
    }
    const total = Math.min(want, peek.remaining);
    if (!total) {
      preview.hidden = false;
      preview.innerHTML = `Nobody is waiting${source.value ? ` from <b>${esc(source.value)}</b>` : ''}.`;
      return;
    }
    // The preview covers the first batch; the last person comes from the batches after.
    preview.hidden = false;
    preview.innerHTML = `
      The next <b>${n(total)}</b> ${total === 1 ? 'person' : 'people'}${source.value ? ` from <b>${esc(source.value)}</b>` : ''}, oldest first${peek.from ? `, starting with those who joined on <b>${date(peek.from)}</b>` : ''}, become <b>wave&nbsp;${peek.wave}</b>.
      Each gets an invite email. ${n(peek.remaining - total)} will still be waiting.
      <div class="meter" data-progress hidden><i style="width:0%"></i></div>
      <div class="note" data-progress-text hidden></div>
      <div class="actions">
        <button class="btn ghost sm" type="button" data-cancel>Cancel</button>
        <button class="btn primary sm" type="button" data-go>Invite ${n(total)} and email them</button>
      </div>`;
    preview.querySelector('[data-cancel]')!.addEventListener('click', () => (preview.hidden = true));
    preview.querySelector<HTMLButtonElement>('[data-go]')!.addEventListener('click', (ev) => runWave(ev.currentTarget as HTMLButtonElement, total, peek.wave));
  });

  const runWave = async (go: HTMLButtonElement, total: number, wave: number) => {
    const bar = preview.querySelector<HTMLElement>('[data-progress]')!;
    const text = preview.querySelector<HTMLElement>('[data-progress-text]')!;
    preview.querySelector<HTMLButtonElement>('[data-cancel]')!.disabled = true;
    go.disabled = true;
    bar.hidden = false;
    text.hidden = false;
    const base = requestId();
    let done = 0;
    for (let i = 0; done < total; i++) {
      const size = Math.min(INVITE_BATCH_MAX, total - done);
      text.textContent = `Inviting ${n(done + 1)}–${n(done + size)} of ${n(total)}…`;
      try {
        const r = await v.api.inviteBatch(size, source.value || null, wave, `${base}:${i}`);
        done += r.invited;
        (bar.firstElementChild as HTMLElement).style.width = `${(done / total) * 100}%`;
        if (r.invited < size) break; // Nobody left to invite.
      } catch (err) {
        text.textContent = `Stopped after ${n(done)}: ${err instanceof Error ? err.message : 'the request failed'}. Run it again to carry on; nobody is invited twice.`;
        go.disabled = false;
        preview.querySelector<HTMLButtonElement>('[data-cancel]')!.disabled = false;
        return;
      }
    }
    toast(`Wave ${wave}: ${n(done)} ${done === 1 ? 'person' : 'people'} let in and emailed.`);
    preview.hidden = true;
    await reload();
  };

  // ── Invite by email ──
  $<HTMLFormElement>('[data-invite-emails]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $<HTMLTextAreaElement>('[data-emails]');
    if (!box.value.trim()) return toast('Paste one or more email addresses.', 'bad');
    const btn = $<HTMLButtonElement>('[data-invite-emails] button[type=submit]');
    try {
      const r = await busy(btn, 'Inviting…', () => v.api.inviteEmails(box.value, null));
      const parts = [`${n(r.invited)} invited`];
      if (r.added) parts.push(`${n(r.added)} new to the list`);
      if (r.already) parts.push(`${n(r.already)} already in`);
      if (r.invalid.length) parts.push(`${n(r.invalid.length)} not valid: ${r.invalid.slice(0, 3).join(', ')}`);
      toast(`${parts.join(' · ')}.`);
      if (!r.invalid.length) box.value = '';
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not invite.', 'bad');
    }
  });
}

function waitingIn(page: WaitlistPage, source: string): number {
  return source ? (page.sources.find((s) => s.source === source)?.waiting ?? 0) : page.funnel.waiting;
}

function unnotifiedBanner(page: WaitlistPage): string {
  const u = page.funnel.unnotified;
  return `${ICON.alert}<span><b>${n(u)}</b> invited ${u === 1 ? 'person has' : 'people have'} no invite email on record, probably from a batch that was cut short.</span><span class="spacer"></span><button class="btn sm" type="button" data-notify-pending>Send ${u === 1 ? 'it' : 'them'} now</button>`;
}

function layout(page: WaitlistPage): string {
  const sourceOptions = page.sources.map((s) => `<option value="${esc(s.source)}">${esc(s.source)} · ${n(s.waiting)} waiting</option>`).join('');
  return `
    <div class="banner" data-banner role="status" ${page.funnel.unnotified ? '' : 'hidden'}>${unnotifiedBanner(page)}</div>
    <div class="grid cols-2">
      <section class="card">
        <div class="card-head"><h2>Let the next wave in</h2><span class="aside">${n(page.funnel.waiting)} waiting</span></div>
        <div class="card-body">
          <form class="invite" data-invite>
            <div class="invite-row">
              <label class="field"><span>How many</span><input class="input num" type="number" min="1" step="1" value="500" data-count /></label>
              <div class="seg" role="group" aria-label="Presets">
                ${PRESETS.map((p, i) => `<button type="button" data-preset="${p}" aria-pressed="${i === 0}">${n(p)}</button>`).join('')}
                <button type="button" data-preset="all" aria-pressed="false">Everyone</button>
              </div>
            </div>
            <div class="invite-row">
              <label class="field" style="flex:1;min-width:180px"><span>From</span>
                <select class="input" data-source><option value="">Every source, oldest first</option>${sourceOptions}</select>
              </label>
              <button class="btn primary" type="submit">Preview</button>
            </div>
            <div class="preview" data-preview hidden></div>
          </form>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Invite by email</h2><span class="aside">Up to 200 at a time</span></div>
        <div class="card-body">
          <form class="invite" data-invite-emails>
            <label class="field"><span class="sr-only">Email addresses</span>
              <textarea class="input" data-emails placeholder="ada@example.com, grace@example.com" spellcheck="false"></textarea>
            </label>
            <div class="invite-row">
              <p class="note" style="margin:0;flex:1">People not on the list are added as hand-picked (wave 0). Anyone already invited is left as they are.</p>
              <button class="btn" type="submit">${ICON.mail}Invite</button>
            </div>
          </form>
        </div>
      </section>
    </div>
    <div class="grid cols-2 section" data-stats>${stats(page)}</div>
    <section class="card section">
      <div class="card-head" style="flex-wrap:wrap;padding-bottom:12px">
        <h2>People</h2>
        <div class="seg" role="group" aria-label="Show">
          ${STATUSES.map(([k, label]) => `<button type="button" data-status="${k}" aria-pressed="${k === 'all'}">${label}</button>`).join('')}
        </div>
        <span class="spacer" style="flex:1"></span>
        <select class="input" data-filter-source aria-label="Source" style="width:auto"><option value="">All sources</option>${page.sources.map((s) => `<option value="${esc(s.source)}">${esc(s.source)}</option>`).join('')}</select>
        <label class="search" style="width:260px"><span class="sr-only">Search emails</span>${ICON.search}<input class="input" data-search type="search" placeholder="Search emails" autocomplete="off" /><kbd>/</kbd></label>
      </div>
      <div data-people>${people(page, { status: 'all', q: '', source: '', offset: 0 })}</div>
    </section>`;
}

function stats(page: WaitlistPage): string {
  return `
    <section class="card">
      <div class="card-head"><h2>Waves</h2><span class="aside">Wave 0 is people invited by hand</span></div>
      <div class="card-body" style="padding:6px 0 4px">
        ${
          page.waves.length
            ? `<div class="table-wrap"><table>
              <thead><tr><th>Wave</th><th>Sent</th><th class="r">Invited</th><th class="r">Signed up</th><th class="r">Paying</th></tr></thead>
              <tbody>${page.waves
                .map(
                  (w) => `<tr><td><b>${w.wave === 0 ? 'Hand-picked' : `Wave ${w.wave}`}</b></td><td class="muted">${date(w.at)}</td><td class="r num">${n(w.invited)}</td>
                  <td class="r num">${n(w.signedUp)} <span class="sub">${pct(w.signedUp, w.invited)}</span></td><td class="r num">${n(w.paid)} <span class="sub">${pct(w.paid, w.signedUp)}</span></td></tr>`,
                )
                .join('')}</tbody></table></div>`
            : '<div class="empty">Nobody has been invited yet.</div>'
        }
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Sources</h2><span class="aside">${n(page.sources.length)} ${page.sources.length === 1 ? 'source' : 'sources'}</span></div>
      <div class="card-body" style="padding:6px 0 4px">
        <div class="table-wrap"><table>
          <thead><tr><th>Source</th><th class="r">On the list</th><th class="r">Waiting</th></tr></thead>
          <tbody>${page.sources.map((s) => `<tr><td>${esc(s.source)}</td><td class="r num">${n(s.total)}</td><td class="r num">${n(s.waiting)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">The list is empty. Import it with tools/import-waitlist.mjs.</td></tr>'}</tbody>
        </table></div>
      </div>
    </section>`;
}

function people(page: WaitlistPage, state: State): string {
  if (!page.rows.length) return `<div class="empty">${state.q ? `Nobody matches “${esc(state.q)}”.` : 'Nobody here.'}</div>`;
  const body = page.rows
    .map((r) => {
      const status = r.signedUpAt
        ? '<span class="badge good">Signed up</span>'
        : r.invitedAt
          ? r.notifiedAt
            ? '<span class="badge info">Invited</span>'
            : '<span class="badge warn">Invited, no email</span>'
          : '<span class="badge plain">Waiting</span>';
      const who = r.userId ? `<a href="#/users/${esc(r.userId)}">${esc(r.email)}</a>` : esc(r.email);
      return `<tr${r.userId ? ` class="link" data-href="#/users/${esc(r.userId)}"` : ''}>
        <td>${who}</td><td class="muted">${esc(r.source)}</td><td class="num muted">${date(r.createdAt)}</td>
        <td>${status}</td><td class="num">${r.wave == null ? '' : r.wave === 0 ? 'Hand-picked' : `Wave ${r.wave}`}</td>
        <td class="num muted">${date(r.invitedAt)}</td><td class="num muted">${date(r.signedUpAt)}</td>
        <td class="r">${r.invitedAt && !r.signedUpAt ? `<button class="btn ghost sm" type="button" data-resend="${esc(r.email)}">Resend</button>` : ''}</td></tr>`;
    })
    .join('');
  const from = page.offset + 1;
  const to = page.offset + page.rows.length;
  return `
    <div class="table-wrap"><table>
      <thead><tr><th>Email</th><th>Source</th><th>Joined list</th><th>Status</th><th>Wave</th><th>Invited</th><th>Signed up</th><th></th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="pager"><span class="num">${n(from)}–${n(to)} of ${n(page.total)}</span><span class="spacer"></span>
      <button class="btn sm" type="button" data-page="-1" ${page.offset ? '' : 'disabled'}>Previous</button>
      <button class="btn sm" type="button" data-page="1" ${to < page.total ? '' : 'disabled'}>Next</button>
    </div>`;
}
