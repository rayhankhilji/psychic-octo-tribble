/**
 * The console's client for `/api/admin/*`. Signed-in calls carry the
 * Supabase access token, as the game's do. Changes get a fresh request id
 * per click, so a retry or a double click runs once on the server.
 */
import { ADMIN_ROUTES, INVITE_BATCH_MAX, type AdminMe, type AuditEntry, type InviteEmailsResult, type InviteResult, type Overview, type UserDetail, type UserSearch, type WaitlistPage } from './types.ts';

export class AdminError extends Error {
  status: number;
  /** The server's error code, e.g. `mfa_required`. */
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `adm-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class AdminApi {
  private token: () => Promise<string | null>;
  private fetchImpl: FetchLike;

  constructor(token: () => Promise<string | null>, fetchImpl: FetchLike = (i, init) => fetch(i, init)) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token();
    let res: Response;
    try {
      res = await this.fetchImpl(path, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AdminError(0, "Couldn't reach the server. Check your connection.");
    }
    const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    if (!res.ok) throw new AdminError(res.status, data?.error ?? `The server answered ${res.status}.`, data?.code);
    return data as T;
  }

  me = () => this.send<AdminMe>('GET', ADMIN_ROUTES.me);
  overview = () => this.send<Overview>('GET', ADMIN_ROUTES.overview);
  search = (q: string) => this.send<UserSearch>('GET', `${ADMIN_ROUTES.users}?q=${encodeURIComponent(q)}`);
  user = (id: string) => this.send<UserDetail>('GET', ADMIN_ROUTES.user(id));
  comp = (id: string, reason: string, interval: 'month' | 'year') => this.send<{ comp: boolean; already?: boolean }>('POST', `${ADMIN_ROUTES.user(id)}/comp`, { reason, interval, requestId: requestId() });
  uncomp = (id: string, reason: string) => this.send<{ comp: boolean }>('DELETE', `${ADMIN_ROUTES.user(id)}/comp`, { reason, requestId: requestId() });
  refresh = (id: string) => this.send<{ ok: boolean; days?: number; mrr?: number | null; error?: string }>('POST', `${ADMIN_ROUTES.user(id)}/refresh`, { requestId: requestId() });
  resendToUser = (id: string) => this.send<{ sent: boolean }>('POST', `${ADMIN_ROUTES.user(id)}/resend-invite`, { requestId: requestId() });
  resend = (email: string) => this.send<{ sent: boolean }>('POST', `${ADMIN_ROUTES.waitlist}/resend`, { email, requestId: requestId() });
  waitlist = (params: { status?: string; source?: string; q?: string; offset?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== 0) qs.set(k, String(v));
    return this.send<WaitlistPage>('GET', `${ADMIN_ROUTES.waitlist}${qs.size ? `?${qs}` : ''}`);
  };
  previewInvite = (count: number, source: string | null) =>
    this.send<InviteResult>('POST', ADMIN_ROUTES.inviteNext, { count: Math.min(count, INVITE_BATCH_MAX), source, dryRun: true });
  inviteBatch = (count: number, source: string | null, wave: number, id: string) => this.send<InviteResult>('POST', ADMIN_ROUTES.inviteNext, { count, source, wave, requestId: id });
  inviteEmails = (emails: string, wave: number | null) => this.send<InviteEmailsResult>('POST', ADMIN_ROUTES.inviteEmails, { emails, ...(wave != null ? { wave } : {}), requestId: requestId() });
  notifyPending = () => this.send<{ sent: number }>('POST', ADMIN_ROUTES.notifyPending, { requestId: requestId() });
  audit = () => this.send<{ entries: AuditEntry[] }>('GET', `${ADMIN_ROUTES.audit}?limit=200`);
}
