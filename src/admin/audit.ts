/** The audit log: every console call, newest first. */
import type { AuditEntry } from './types.ts';
import { dateTime, esc, n } from './ui.ts';
import { failure, type View } from './view.ts';

export const LABELS: Record<string, string> = {
  'console.open': 'Opened the console',
  'overview.read': 'Viewed the overview',
  'users.search': 'Searched users',
  'user.read': 'Viewed a founder',
  'waitlist.read': 'Viewed the waitlist',
  'waitlist.invite_preview': 'Previewed a wave',
  'waitlist.invite_next': 'Invited a wave',
  'waitlist.invite_emails': 'Invited by email',
  'waitlist.resend': 'Resent an invite',
  'waitlist.notify_pending': 'Sent missed invites',
  'comp.grant': 'Comped a plan',
  'comp.revoke': 'Revoked a comp',
  'timeline.refresh': 'Refreshed data',
  'audit.read': 'Viewed the audit log',
};

export const READS = new Set(['console.open', 'overview.read', 'users.search', 'user.read', 'waitlist.read', 'audit.read', 'waitlist.invite_preview']);

/** One line about what a change did, from its stored input and result. */
function summary(e: AuditEntry): string {
  const input = (e.detail.input ?? {}) as Record<string, unknown>;
  const result = (e.detail.result ?? {}) as Record<string, unknown>;
  if (e.status === 'error') return String(e.detail.error ?? 'Failed');
  if (e.action === 'waitlist.invite_next') return `${n(Number(result.invited ?? 0))} invited · wave ${esc(input.wave)}${input.source ? ` · ${esc(input.source)}` : ''}`;
  if (e.action === 'waitlist.invite_emails') return `${n(Number(result.invited ?? 0))} invited${result.added ? `, ${n(Number(result.added))} added` : ''}`;
  if (e.action === 'waitlist.notify_pending') return `${n(Number(result.sent ?? 0))} sent`;
  if (e.action.startsWith('comp.')) return esc(input.reason ?? '');
  if (e.action === 'timeline.refresh') return result.ok === false ? `Failed: ${esc(result.error)}` : result.days != null ? `${n(Number(result.days))} days` : '';
  return '';
}

export async function auditPage(v: View) {
  v.title('Audit log');
  v.root.innerHTML = '<div class="skeleton" style="height:420px"></div>';
  let entries: AuditEntry[];
  try {
    entries = (await v.api.audit()).entries;
  } catch (err) {
    if (!v.stale()) failure(v.root, err);
    return;
  }
  if (v.stale()) return;
  let changesOnly = true;
  const draw = () => {
    const shown = changesOnly ? entries.filter((e) => !READS.has(e.action)) : entries;
    v.stamp(`Latest ${n(entries.length)} entries`);
    v.root.innerHTML = `
      <section class="card">
        <div class="card-head" style="padding-bottom:12px">
          <h2>${changesOnly ? 'Changes' : 'Everything'}</h2>
          <div class="seg" role="group" aria-label="Show">
            <button type="button" data-changes="1" aria-pressed="${changesOnly}">Changes</button>
            <button type="button" data-changes="0" aria-pressed="${!changesOnly}">Everything, including views</button>
          </div>
        </div>
        ${
          shown.length
            ? `<div class="table-wrap"><table>
              <thead><tr><th>When</th><th>Admin</th><th>What</th><th>Target</th><th>Detail</th><th>Result</th></tr></thead>
              <tbody>${shown
                .map((e) => {
                  const target = e.target && /^[0-9a-f-]{36}$/i.test(e.target) ? `<a class="mono" href="#/users/${esc(e.target)}">${esc(e.target.slice(0, 8))}…</a>` : esc(e.target ?? '');
                  const tone = e.status === 'ok' ? 'good' : e.status === 'error' ? 'bad' : 'warn';
                  return `<tr><td class="num muted">${dateTime(e.at)}</td><td>${esc(e.adminEmail)}</td><td>${esc(LABELS[e.action] ?? e.action)}</td><td>${target}</td>
                    <td class="wrap muted">${summary(e)}</td><td><span class="badge ${tone}">${e.status === 'ok' ? 'Done' : e.status === 'error' ? 'Failed' : 'Running'}</span></td></tr>`;
                })
                .join('')}</tbody></table></div>`
            : '<div class="empty">No changes yet.</div>'
        }
      </section>`;
  };
  v.root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-changes]');
    if (!b) return;
    changesOnly = b.dataset.changes === '1';
    draw();
  });
  draw();
}
