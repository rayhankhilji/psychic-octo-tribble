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
  };
}
