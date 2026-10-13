/**
 * The admin console's API (`/api/admin/*`, server/admin.ts): what each call
 * returns. Both sides import these, like src/api/contract.ts for the game.
 * Times are ms since epoch; money is in minor units (cents).
 *
 * Every route answers 404 to anyone who isn't a signed-in admin, so the
 * console isn't advertised. Changes take a `requestId` the browser makes up
 * once per click: a retried or double-clicked request runs once and the
 * repeat gets the first answer back.
 */

export const ADMIN_ROUTES = {
  me: '/api/admin/me',
  overview: '/api/admin/overview',
  users: '/api/admin/users',
  /** `/api/admin/users/:id`, plus `/comp` (POST grant, DELETE revoke), `/refresh` and `/resend-invite` (POST). */
  user: (id: string) => `/api/admin/users/${encodeURIComponent(id)}`,
  waitlist: '/api/admin/waitlist',
  inviteNext: '/api/admin/waitlist/invite',
  inviteEmails: '/api/admin/waitlist/invite-emails',
  notifyPending: '/api/admin/waitlist/notify-pending',
  audit: '/api/admin/audit',
} as const;

/** Most people one invite call lets in. The console loops for bigger waves, one batch at a time. */
export const INVITE_BATCH_MAX = 500;
/** Most addresses one "invite these emails" call takes. */
export const INVITE_EMAILS_MAX = 200;

export type AccessMode = 'open' | 'waitlist';

/** `GET /api/admin/me` */
export interface AdminMe {
  email: string;
  access: AccessMode;
  now: number;
}

export interface Movement {
  /** Founders who gained paid access (comps not counted). */
  started: number;
  /** Founders who lost it. */
  ended: number;
}

export interface WaitlistFunnel {
  total: number;
  waiting: number;
  invited: number;
  /** Invited and signed in at least once. */
  signedUp: number;
  /** Signed up and paying now (comps not counted). */
  paid: number;
  /** Invited but the email was never handed over (an interrupted batch). */
  unnotified: number;
  lastWave: number | null;
}

/** `GET /api/admin/overview` */
export interface Overview {
  generatedAt: number;
  /** Where movement and the series came from: the nightly `product_daily` table, or counted live. */
  source: 'product_daily' | 'live';
  access: AccessMode;
  /** Founders who have opened the app with access (a profile exists). */
  accounts: { total: number; d1: number; d7: number; d30: number };
  paying: {
    /** Paid access by any route, comps included. */
    total: number;
    monthly: number;
    yearly: number;
    comp: number;
    pastDue: number;
    /** Paying, but set to cancel at the end of the period. */
    cancelling: number;
  };
  /** Stripe plans only, at our current prices; null when billing isn't set up. */
  mrr: { amount: number; currency: string } | null;
  movement: { d1: Movement; d7: Movement; d30: Movement } | null;
  waitlist: WaitlistFunnel | null;
  connections: {
    stripe: { total: number; live: number; test: number; broken: number };
    github: { total: number; noRepo: number };
    posthog: number;
    /** Founders whose Stripe connection needs reconnecting (up to 20), to open one by one. */
    broken: { userId: string; reason: string }[];
  };
  /** The last 30 days from product_daily, oldest first; empty when that table doesn't exist yet. */
  series: { day: number; mrr: number | null; paying: number | null; accounts: number | null }[];
}

/** A row in the user search. */
export interface UserHit {
  id: string;
  email: string | null;
  createdAt: number | null;
  lastSignInAt: number | null;
  plan: string;
  comp: boolean;
}

export interface WaitlistEntry {
  email: string;
  source: string;
  createdAt: number;
  invitedAt: number | null;
  wave: number | null;
  notifiedAt: number | null;
  signedUpAt: number | null;
  userId: string | null;
}

/** `GET /api/admin/users?q=` (an email or part of one, a user id, `cus_…` or `acct_…`; empty for the newest) */
export interface UserSearch {
  q: string;
  users: UserHit[];
  /** Waitlist entries that match, for people who haven't signed in yet. */
  waitlist: WaitlistEntry[];
}

export interface AuditEntry {
  id: number;
  at: number;
  adminEmail: string;
  action: string;
  target: string | null;
  status: 'started' | 'ok' | 'error';
  detail: Record<string, unknown>;
}

export interface ConnectionInfo {
  provider: 'stripe' | 'github' | 'posthog';
  account: string;
  name: string | null;
  livemode: boolean | null;
  connectedAt: number | null;
  /** Repository for GitHub, host for PostHog. */
  detail: string | null;
  /** 'ok', or why it needs the founder to reconnect. */
  health: string;
}

/** `GET /api/admin/users/:id` */
export interface UserDetail {
  user: { id: string; email: string | null; createdAt: number | null; lastSignInAt: number | null; providers: string[]; confirmed: boolean } | null;
  profile: { name: string; seed: number; joinedAt: number | null; lastSeen: number | null; createdAt: number | null } | null;
  plan: {
    status: string;
    interval: 'month' | 'year' | null;
    renewsAt: number | null;
    cancelAtPeriodEnd: boolean;
    livemode: boolean | null;
    stripeCustomer: string | null;
    stripeSubscription: string | null;
    comp: { reason: string | null; by: string | null; at: number | null } | null;
  } | null;
  connections: ConnectionInfo[];
  world: { actions: number; built: number; homeMoves: number; version: number; recent: { t: number; what: string }[] } | null;
  timeline: { fetchedAt: number; days: number; mrr: number | null; customers: number | null } | null;
  waitlist: WaitlistEntry | null;
  history: { at: number; change: string; status: string | null; interval: string | null; comp: boolean }[];
  audit: AuditEntry[];
}

/** `POST /api/admin/waitlist/invite` { count, source?, wave?, dryRun?, requestId } */
export interface InviteResult {
  /** Newly invited by this call (a repeat of the same requestId reports the first call's numbers). */
  invited: number;
  wave: number;
  /** Still waiting afterwards, within the chosen source (or overall). */
  remaining: number;
  /** For a dry run: who would be next, as a range of join dates. */
  from?: number | null;
  to?: number | null;
  dryRun?: boolean;
}

/** `POST /api/admin/waitlist/invite-emails` { emails, wave?, requestId } */
export interface InviteEmailsResult {
  invited: number;
  /** Already invited before; left as they were. */
  already: number;
  /** Not on the list before; added with source `admin`. */
  added: number;
  invalid: string[];
  wave: number;
}

/** `GET /api/admin/waitlist?status=&source=&q=&offset=` */
export interface WaitlistPage {
  rows: WaitlistEntry[];
  total: number;
  offset: number;
  limit: number;
  funnel: WaitlistFunnel;
  sources: { source: string; total: number; waiting: number }[];
  waves: { wave: number; invited: number; signedUp: number; paid: number; at: number | null }[];
}
