import type { Ctx, Hosted } from '../context.ts';
import { sha256 } from '../crypto.ts';
import type { EmailMessage, EmailProvider } from './provider.ts';
import type { Brand } from './templates.ts';
import { inList, insertNew, removeWhere, select, upsertMany } from './store.ts';

/**
 * Sending once. Stripe retries webhooks, people double-click, two servers
 * can handle the same event: each email we mean to send once has a dedupe
 * key, and a row in `email_log` claims it before anything is sent.
 *
 * - The claim is an insert that skips existing keys, so of two racing
 *   senders exactly one wins.
 * - If the send fails, the claim is released so a later retry can send.
 * - If a server dies between claiming and sending, the claim goes stale
 *   after 15 minutes and the next attempt takes it over.
 * - The provider gets the same key as its Idempotency-Key, so even a send
 *   that succeeded but never got marked is not sent twice (Resend keeps
 *   keys for 24 hours).
 */

export interface EmailLogRow {
  dedupe_key: string;
  user_id: string | null;
  kind: string;
  status: 'sending' | 'sent';
  provider: string | null;
  provider_id: string | null;
  created_at: string;
  sent_at: string | null;
}

export const STALE_CLAIM_MS = 15 * 60_000;

/** The log's key: kind, who and the event's own reference, hashed so no address is stored. */
export function dedupeKey(kind: string, recipient: string, ref: string): string {
  return sha256(`${kind}\n${recipient}\n${ref}`);
}

/** Who the log line names: a user id, or "guest" for mail to an address with no account. Never an address. */
const who = (userId: string | null) => userId ?? 'guest';

export interface Outgoing {
  kind: string;
  userId: string | null;
  key: string;
  message: EmailMessage;
}

export type Outcome = 'sent' | 'duplicate' | 'failed';

/**
 * Claims the key, sends, and records the provider's id. `logged: false`
 * skips the table (for mail after an account is deleted, when no row about
 * the person should be written) and relies on the provider's idempotency
 * key alone.
 */
export async function deliver(ctx: Hosted, provider: EmailProvider, out: Outgoing, logged = true): Promise<Outcome> {
  if (logged && !(await claim(ctx, out))) return 'duplicate';
  try {
    const id = await provider.send(out.message, `tt-${out.key}`);
    if (logged) await markSent(ctx, provider.name, [{ out, id }]).catch(() => console.error(`email ${out.kind} for ${who(out.userId)}: sent, but the log couldn't be updated`));
    return 'sent';
  } catch (err) {
    console.error(`email ${out.kind} for ${who(out.userId)} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    if (logged) await release(ctx, [out.key]).catch(() => undefined);
    return 'failed';
  }
}

/** True if this caller now owns the key. */
async function claim(ctx: Hosted, out: Outgoing): Promise<boolean> {
  const claimed = await claimMany(ctx, [out]);
  if (claimed.size) return true;
  // Someone holds it. Take it over only if they claimed it long ago and never finished.
  const [row] = await select<EmailLogRow>(ctx.supabase, 'email_log', `select=status,created_at&dedupe_key=eq.${out.key}&limit=1`);
  if (!row || row.status !== 'sending' || Date.parse(row.created_at) > ctx.now - STALE_CLAIM_MS) return false;
  const taken = await ctx.db.update<EmailLogRow>('email_log', { dedupe_key: out.key, status: 'sending', created_at: row.created_at }, { created_at: new Date(ctx.now).toISOString() });
  return taken.length > 0;
}

/** Claims many keys in one insert; returns the keys this caller won. */
export async function claimMany(ctx: Hosted, outs: Outgoing[]): Promise<Set<string>> {
  const rows = await insertNew<{ dedupe_key: string }>(
    ctx.supabase,
    'email_log',
    outs.map((o) => ({ dedupe_key: o.key, user_id: o.userId, kind: o.kind, status: 'sending', created_at: new Date(ctx.now).toISOString() })),
    'dedupe_key',
  );
  return new Set(rows.map((r) => r.dedupe_key));
}

export async function markSent(ctx: Hosted, providerName: string, sent: { out: Outgoing; id: string }[]): Promise<void> {
  const at = new Date(ctx.now).toISOString();
  await upsertMany(
    ctx.supabase,
    'email_log',
    sent.map(({ out, id }) => ({ dedupe_key: out.key, user_id: out.userId, kind: out.kind, status: 'sent', provider: providerName, provider_id: id || null, sent_at: at })),
    'dedupe_key',
  );
}

export async function release(ctx: Hosted, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await removeWhere(ctx.supabase, 'email_log', `dedupe_key=${inList(keys)}&status=eq.sending`);
}

/** Links and footer details for this deployment. */
export function brandFor(ctx: Ctx): Brand {
  const env = (name: string) => ctx.env[name]?.trim() || null;
  return {
    appUrl: (ctx.s.appUrl ?? ctx.url.origin).replace(/\/+$/, ''),
    replies: !!env('EMAIL_REPLY_TO'),
    supportEmail: env('SUPPORT_EMAIL'),
    postalAddress: env('EMAIL_POSTAL_ADDRESS'),
  };
}
