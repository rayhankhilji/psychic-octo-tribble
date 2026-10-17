/**
 * Sign-in, through Supabase Auth. `@supabase/supabase-js` is loaded only when
 * it's needed (someone signs in, or this browser already holds a session),
 * so the demo's first paint never pays for it. The browser gets the public
 * URL and anon key from `GET /api/config`, never from the build.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type OAuthProvider = 'google' | 'github';

export interface AuthSession {
  email: string | null;
}

/** What the shell needs from sign-in. The dev mock (mock.ts) implements it too. */
export interface AuthProvider {
  /** Restores the session this browser holds, or picks one up from a sign-in redirect. */
  restore(): Promise<AuthSession | null>;
  /** A fresh access token for API calls (refreshed when it has expired), or null. */
  token(): Promise<string | null>;
  /** Sends a magic link (with the Turnstile token when the bot check is on). Resolves once the email is on its way. */
  signInWithEmail(email: string, captchaToken?: string | null): Promise<void>;
  /**
   * Signs in with the 6-digit code from the same email, for when a mail scanner
   * used up the link first. Resolves once this browser holds the session.
   */
  verifyEmailCode(email: string, code: string): Promise<void>;
  /** Leaves for Google or GitHub; the provider sends the browser back here. */
  signInWithOAuth(provider: OAuthProvider): Promise<void>;
  signOut(): Promise<void>;
  /** Why the last sign-in redirect failed (an expired link, a cancelled consent), in plain words. */
  readonly redirectError: string | null;
}

/** Fixed, so we can tell whether a session might exist without loading the library. */
const STORAGE_KEY = 'tinytown-auth';

/** A sign-in error with a sentence a person can act on. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Pure: the redirect's error parameters (from the URL hash or query) → plain words, or null.
 * Supabase sends e.g. `#error=access_denied&error_code=otp_expired&error_description=…`.
 */
export function describeRedirectError(params: URLSearchParams): string | null {
  const error = params.get('error');
  const code = params.get('error_code') ?? '';
  if (!error && !code) return null;
  if (code === 'otp_expired' || /expired|invalid/i.test(params.get('error_description') ?? '')) {
    return 'That sign-in link has expired or was already used. Send yourself a fresh one.';
  }
  if (error === 'access_denied') return 'Sign-in was cancelled. Nothing was shared.';
  if (code === 'provider_email_needs_verification') return 'Confirm your email address with that provider first, then try again.';
  return "Sign-in didn't finish. Try again, or use a different way in.";
}

/** Pure: Supabase's sign-in errors → what to tell the person. */
export function describeSignInError(err: { status?: number; message?: string; code?: string } | null | undefined): string {
  const msg = err?.message ?? '';
  if (err?.status === 429 || err?.code === 'over_email_send_rate_limit' || /rate limit|too many/i.test(msg)) {
    return 'Too many links in a short time. Wait a minute, then try again.';
  }
  if (err?.code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg)) return "That email address doesn't look right.";
  if (err?.code === 'signup_disabled' || /signups not allowed/i.test(msg)) return 'New sign-ups are paused for a moment. Try again soon.';
  if (err?.code === 'captcha_failed' || /captcha/i.test(msg)) return "The quick check that you're a person didn't go through. Try it again.";
  if (/fetch|network/i.test(msg)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  return "Couldn't send the link. Try again in a moment.";
}

/** Pure: why a typed code didn't work. */
export function describeCodeError(err: { status?: number; message?: string; code?: string } | null | undefined): string {
  const msg = err?.message ?? '';
  if (err?.status === 429 || /rate limit|too many/i.test(msg)) return 'Too many tries in a short time. Wait a minute, then try again.';
  if (err?.code === 'otp_expired' || /expired|invalid|token/i.test(msg)) return "That code is wrong or has expired. Check it against the newest email, or send yourself a fresh one.";
  if (/fetch|network/i.test(msg)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  return "That code didn't work. Try again, or use the link in the email.";
}

/** Where providers send people back: this page, without the query that brought them. */
function returnUrl(): string {
  return `${location.origin}/`;
}

export class SupabaseAuth implements AuthProvider {
  private url: string;
  private anonKey: string;
  private client: Promise<SupabaseClient> | null = null;
  private _redirectError: string | null = null;

  constructor(cfg: { url: string; anonKey: string }) {
    this.url = cfg.url;
    this.anonKey = cfg.anonKey;
    // Read (and then tidy away) anything a sign-in redirect left in the URL.
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    this._redirectError = describeRedirectError(hash) ?? describeRedirectError(new URLSearchParams(location.search));
  }

  get redirectError() {
    return this._redirectError;
  }

  /** True when there may be a session to restore: one saved in this browser, or tokens arriving in the URL. */
  private mayHaveSession(): boolean {
    if (/access_token=|refresh_token=/.test(location.hash)) return true;
    try {
      return !!localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
  }

  private load(): Promise<SupabaseClient> {
    // Its own chunk: only signed-in visitors (or someone signing in) download it.
    this.client ??= import('./supabase.ts').then(({ createClient }) =>
      createClient(this.url, this.anonKey, {
        auth: {
          storageKey: STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          // Implicit: a magic link opened on another device (a phone's mail app) still signs you in there.
          flowType: 'implicit',
        },
      }),
    );
    return this.client;
  }

  async restore(): Promise<AuthSession | null> {
    const fromRedirect = /access_token=|error=/.test(location.hash);
    if (!this.mayHaveSession()) {
      if (fromRedirect) tidyUrl();
      return null;
    }
    try {
      const c = await this.load();
      const { data } = await c.auth.getSession();
      return data.session ? { email: data.session.user.email ?? null } : null;
    } catch {
      return null;
    } finally {
      // Tokens never linger in the address bar (or in a screenshot of it).
      if (fromRedirect) tidyUrl();
    }
  }

  async token(): Promise<string | null> {
    if (!this.client) return null;
    const c = await this.client;
    const { data } = await c.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async signInWithEmail(email: string, captchaToken?: string | null): Promise<void> {
    let c: SupabaseClient;
    try {
      c = await this.load();
    } catch {
      throw new AuthError("Couldn't load sign-in. Check your connection and try again.");
    }
    const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl(), shouldCreateUser: true, ...(captchaToken ? { captchaToken } : {}) } });
    if (error) throw new AuthError(describeSignInError(error as { status?: number; message?: string; code?: string }));
  }

  async verifyEmailCode(email: string, code: string): Promise<void> {
    let c: SupabaseClient;
    try {
      c = await this.load();
    } catch {
      throw new AuthError("Couldn't load sign-in. Check your connection and try again.");
    }
    const { error } = await c.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error) throw new AuthError(describeCodeError(error as { status?: number; message?: string; code?: string }));
  }

  async signInWithOAuth(provider: OAuthProvider): Promise<void> {
    let c: SupabaseClient;
    try {
      c = await this.load();
    } catch {
      throw new AuthError("Couldn't load sign-in. Check your connection and try again.");
    }
    const { error } = await c.auth.signInWithOAuth({ provider, options: { redirectTo: returnUrl() } });
    if (error) throw new AuthError(describeSignInError(error as { status?: number; message?: string; code?: string }));
  }

  async signOut(): Promise<void> {
    try {
      if (this.mayHaveSession()) await (await this.load()).auth.signOut();
    } catch {
      // Signed out locally below either way.
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing stored.
    }
  }
}

function tidyUrl() {
  history.replaceState(history.state, '', location.pathname + location.search);
}
