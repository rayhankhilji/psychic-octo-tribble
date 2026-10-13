/**
 * Sign-in for the console: the same Supabase project and the same saved
 * session as the game (one storage key), so an admin already signed in to
 * TinyTown is signed in here. Links and provider redirects come back to
 * /admin.html; if that address isn't in Supabase's redirect allow-list they
 * land on the game instead, still signed in, and the console picks the
 * session up on the next visit.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConfigResponse } from '../api/contract.ts';
import { describeRedirectError, describeSignInError } from '../api/auth.ts';

/** Must match src/api/auth.ts, so both pages share one session. */
const STORAGE_KEY = 'tinytown-auth';

export interface ConsoleAuth {
  email(): Promise<string | null>;
  token(): Promise<string | null>;
  signInWithEmail(email: string): Promise<void>;
  signInWithOAuth(provider: 'google' | 'github'): Promise<void>;
  signOut(): Promise<void>;
  readonly redirectError: string | null;
  /** Email links need a bot check when Supabase has captcha on; the console offers providers only then. */
  readonly emailAllowed: boolean;
  /** The second factor the console asks admins for (a TOTP authenticator app). */
  mfa: {
    /** A verified authenticator already on the account, if any. */
    factor(): Promise<string | null>;
    /** Starts adding one: the QR code (an SVG data URL) and the secret to type in by hand. */
    enroll(): Promise<{ factorId: string; qr: string; secret: string }>;
    /** Checks a 6-digit code; on success the session is raised to aal2. */
    verify(factorId: string, code: string): Promise<void>;
  };
}

const back = () => `${location.origin}/admin.html`;

export function supabaseAuth(cfg: ConfigResponse): ConsoleAuth {
  const supabase = cfg.supabase!;
  let client: Promise<SupabaseClient> | null = null;
  const load = () =>
    (client ??= import('../api/supabase.ts').then(({ createClient }) =>
      createClient(supabase.url, supabase.anonKey, {
        auth: { storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
      }),
    ));
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const redirectError = describeRedirectError(hash) ?? describeRedirectError(new URLSearchParams(location.search));
  const session = async () => (await (await load()).auth.getSession()).data.session;

  return {
    redirectError,
    emailAllowed: !cfg.captcha,
    async email() {
      try {
        return (await session())?.user.email ?? null;
      } finally {
        // Tokens never linger in the address bar.
        if (/access_token=|error=/.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
      }
    },
    async token() {
      return (await session())?.access_token ?? null;
    },
    async signInWithEmail(email) {
      // shouldCreateUser: false, so this page never makes accounts. Supabase
      // then refuses unknown addresses; that answer looks like success here,
      // so the form can't be used to find out who has an account.
      const { error } = await (await load()).auth.signInWithOtp({ email, options: { emailRedirectTo: back(), shouldCreateUser: false } });
      if (error && ((error as { code?: string }).code === 'otp_disabled' || /signups not allowed/i.test(error.message))) return;
      if (error) throw new Error(describeSignInError(error as { status?: number; message?: string; code?: string }));
    },
    async signInWithOAuth(provider) {
      const { error } = await (await load()).auth.signInWithOAuth({ provider, options: { redirectTo: back() } });
      if (error) throw new Error(describeSignInError(error as { status?: number; message?: string; code?: string }));
    },
    async signOut() {
      try {
        await (await load()).auth.signOut();
      } catch {
        // Signed out locally either way.
      }
    },
    mfa: {
      async factor() {
        const { data, error } = await (await load()).auth.mfa.listFactors();
        if (error) throw new Error(error.message);
        return data.totp.find((f) => f.status === 'verified')?.id ?? null;
      },
      async enroll() {
        const mfa = (await load()).auth.mfa;
        // A half-finished setup from an earlier visit would block a new one: clear it first.
        const { data: list } = await mfa.listFactors();
        for (const f of list?.all ?? []) if (f.factor_type === 'totp' && f.status !== 'verified') await mfa.unenroll({ factorId: f.id });
        const { data, error } = await mfa.enroll({ factorType: 'totp', friendlyName: 'TinyTown admin' });
        if (error) throw new Error(error.message);
        return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
      },
      async verify(factorId, code) {
        const { error } = await (await load()).auth.mfa.challengeAndVerify({ factorId, code });
        if (error) throw new Error(/invalid|expired/i.test(error.message) ? 'That code didn’t work. Check the time on your phone and try the newest one.' : error.message);
      },
    },
  };
}

/** The dev mock: always signed in as the owner. */
export function mockAuth(): ConsoleAuth {
  return {
    redirectError: null,
    emailAllowed: true,
    email: async () => 'owner@tinytown.dev',
    token: async () => 'mock-token',
    signInWithEmail: async () => undefined,
    signInWithOAuth: async () => undefined,
    signOut: async () => undefined,
    // ?mock&mfa shows the second-factor screens: 123456 is the right code.
    mfa: {
      factor: async () => (new URLSearchParams(location.search).has('enrolled') ? 'mock-factor' : null),
      enroll: async () => ({ factorId: 'mock-factor', qr: '/mark.svg', secret: 'JBSWY3DPEHPK3PXP' }),
      verify: async (_id, code) => {
        if (code !== '123456') throw new Error('That code didn’t work. Check the time on your phone and try the newest one.');
        sessionStorage.setItem('tt-mock-aal2', '1');
      },
    },
  };
}
