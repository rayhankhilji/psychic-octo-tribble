/**
 * Sign in: Google, GitHub, or a magic link by email. No passwords. Signing
 * in for the first time makes the account; the provider sends the browser
 * back here and boot picks the session up.
 */
import type { AuthProvider, OAuthProvider } from '../api/auth.ts';
import { LEGAL } from '../api/contract.ts';
import { markSvg } from './brand.ts';
import { busy, focusFirst, makeDialog, message } from './dialogs.ts';
import { escape, showModal } from './dom.ts';
import { ICON } from './icons.ts';
import { Captcha } from './turnstile.ts';

/** Google's own mark, as its sign-in guidelines ask; everything else uses our icon family. */
const GOOGLE = `<svg class="ico logo" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.96 10.71A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"/></svg>`;

const RESEND_AFTER_S = 60;
const CODE_LENGTH = 6;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export class SignInDialog {
  private d: HTMLDialogElement;
  private auth: AuthProvider;
  private live: HTMLElement;
  private body: HTMLElement;
  private sent = false;
  private email = '';
  private error: string | null = null;
  private context: string | null = null;
  private resendAt = 0;
  private timer = 0;
  private captcha: Captcha | null;

  constructor(auth: AuthProvider, opts: { captchaSiteKey?: string | null } = {}) {
    this.auth = auth;
    this.captcha = opts.captchaSiteKey ? new Captcha(opts.captchaSiteKey) : null;
    this.d = makeDialog('auth-dialog', 'signin-title', () => window.clearInterval(this.timer));
    this.body = document.createElement('div');
    this.live = document.createElement('p');
    this.live.className = 'sr-only';
    this.live.setAttribute('role', 'status');
    this.d.append(this.body, this.live);
    this.d.addEventListener('click', (e) => this.onClick(e));
    this.d.addEventListener('submit', (e) => {
      e.preventDefault();
      if ((e.target as HTMLElement).classList.contains('otp-form')) void this.verifyCode();
      else void this.send();
    });
    // The code field takes digits only, however it arrives (typed, pasted with spaces, autofilled), and submits at six.
    this.d.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name !== 'code') return;
      const digits = t.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
      if (t.value !== digits) t.value = digits;
      if (t.getAttribute('aria-invalid')) {
        t.removeAttribute('aria-invalid');
        this.body.querySelector('#otp-error')!.innerHTML = '';
      }
      if (digits.length === CODE_LENGTH) void this.verifyCode();
    });
  }

  /** `context` says what happens after signing in (e.g. the plan they picked); `error` is from a failed redirect. */
  open(opts: { context?: string | null; error?: string | null } = {}) {
    this.context = opts.context ?? null;
    this.error = opts.error ?? null;
    this.sent = false;
    this.render();
    showModal(this.d);
    focusFirst(this.d, this.error ? 'input[name=email]' : '[data-autofocus]');
  }

  close() {
    this.d.close();
  }

  private render() {
    window.clearInterval(this.timer);
    if (this.sent) return this.renderSent();
    this.body.className = 'dialog-body auth';
    this.body.innerHTML = `
      <header class="dialog-head">
        <span class="tile auth-mark">${markSvg({ cls: 'auth-logo' })}</span>
        <div><h2 id="signin-title">Sign in to TinyTown</h2><p>New here? Signing in makes your account. There's no password to remember.</p></div>
        <button class="btn ghost icon-only close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
      </header>
      ${this.context ? `<p class="auth-context">${ICON.arrowRight}<span>${escape(this.context)}</span></p>` : ''}
      <div class="auth-providers">
        <button class="btn auth-btn" type="button" data-provider="google" data-autofocus>${GOOGLE}<span class="label">Continue with Google</span></button>
        <button class="btn auth-btn" type="button" data-provider="github">${ICON.github}<span class="label">Continue with GitHub</span></button>
      </div>
      <div class="auth-or" role="separator"><span>or with your email</span></div>
      <form class="auth-email" novalidate>
        <label class="field">
          <span>Email address</span>
          <input type="email" name="email" autocomplete="email" inputmode="email" spellcheck="false" placeholder="you@yourstartup.com" value="${escape(this.email)}" required ${this.error ? 'aria-invalid="true" aria-describedby="signin-error"' : ''}>
        </label>
        ${this.captcha ? '<div class="captcha-slot"></div>' : ''}
        <div id="signin-error">${this.error ? message('bad', this.error) : ''}</div>
        <button class="btn primary block" type="submit">${ICON.mail}<span class="label">Email me a sign-in link</span></button>
      </form>
      <p class="auth-fine">${ICON.shield}<span>We use your email to sign you in and for your receipts, nothing else. By signing in you agree to the <a href="${LEGAL.terms}" target="_blank" rel="noopener">Terms</a> and <a href="${LEGAL.privacy}" target="_blank" rel="noopener">Privacy Policy</a>.</span></p>`;
    const slot = this.body.querySelector<HTMLElement>('.captcha-slot');
    if (slot && this.captcha) void this.captcha.mount(slot);
  }

  private renderSent() {
    this.body.className = 'dialog-body auth auth-sent';
    this.body.innerHTML = `
      <button class="btn ghost icon-only close auth-sent-close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
      <div class="sent-art" aria-hidden="true"><span class="sent-envelope">${ICON.mailOpen}</span><span class="sent-spark">${ICON.sparkle}</span></div>
      <h2 id="signin-title">Check your inbox</h2>
      <p class="sent-lede">We sent a sign-in link to <b>${escape(this.email)}</b>. Open it on this device or any other, and you'll land back in TinyTown, signed in.</p>
      <ul class="sent-tips">
        <li>${ICON.info}<span>It can take a minute to arrive. If it doesn't, look in spam.</span></li>
        <li>${ICON.lock}<span>The link and the code work once, for an hour.</span></li>
      </ul>
      <form class="otp-form" novalidate>
        <label class="field" for="otp-code"><span>Or enter the 6-digit code from the email</span></label>
        <div class="otp-row">
          <input id="otp-code" class="otp-input num" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="${CODE_LENGTH}" spellcheck="false" placeholder="••••••" data-autofocus aria-describedby="otp-help otp-error">
          <button class="btn primary" type="submit">Sign in</button>
        </div>
        <p class="field-help" id="otp-help">Handy if a work email scanner opened the link before you could.</p>
        <div id="otp-error"></div>
      </form>
      ${this.captcha ? '<div class="captcha-slot"></div>' : ''}
      <div class="dialog-actions">
        <button class="btn ghost" type="button" data-act="change">Use a different email</button>
        <button class="btn" type="button" data-act="resend"></button>
      </div>`;
    const slot = this.body.querySelector<HTMLElement>('.captcha-slot');
    if (slot && this.captcha) void this.captcha.mount(slot);
    this.tickResend();
    this.timer = window.setInterval(() => this.tickResend(), 1000);
  }

  private tickResend() {
    const btn = this.body.querySelector<HTMLButtonElement>('[data-act=resend]');
    if (!btn || btn.classList.contains('is-busy')) return;
    const left = Math.ceil((this.resendAt - Date.now()) / 1000);
    btn.disabled = left > 0;
    const text = left > 0 ? `Resend in 0:${String(left).padStart(2, '0')}` : 'Resend the link';
    if (btn.textContent !== text) btn.innerHTML = `${ICON.refresh}<span class="label num">${text}</span>`;
    if (left <= 0) window.clearInterval(this.timer);
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const provider = t.closest<HTMLButtonElement>('[data-provider]');
    if (provider) return this.oauth(provider);
    const act = t.closest<HTMLButtonElement>('[data-act]')?.dataset.act;
    if (act === 'change') {
      this.sent = false;
      this.error = null;
      this.render();
      focusFirst(this.d, 'input[name=email]');
    }
    if (act === 'resend') await this.send(true);
  }

  private async oauth(btn: HTMLButtonElement) {
    const p = btn.dataset.provider as OAuthProvider;
    this.body.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((b) => b !== btn && (b.disabled = true));
    const done = busy(btn, `Opening ${p === 'google' ? 'Google' : 'GitHub'}…`);
    try {
      // On success the browser leaves for the provider; we only come back here on failure.
      await this.auth.signInWithOAuth(p);
    } catch (err) {
      done();
      this.body.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach((b) => (b.disabled = false));
      this.showError(err instanceof Error ? err.message : "Couldn't start sign-in. Try again.");
    }
  }

  private async send(again = false) {
    const input = this.body.querySelector<HTMLInputElement>('input[name=email]');
    if (input) this.email = input.value.trim();
    if (!EMAIL.test(this.email)) {
      this.showError(this.email ? "That email address doesn't look right." : 'Enter your email address first.');
      input?.focus();
      return;
    }
    const btn = this.body.querySelector<HTMLButtonElement>(again ? '[data-act=resend]' : 'button[type=submit]');
    const done = busy(btn, this.captcha ? 'Checking…' : 'Sending…');
    try {
      let token: string | null = null;
      if (this.captcha) {
        token = await this.captcha.token();
        if (!token) throw new Error("The quick check that you're a person couldn't load. Check your connection, or try Google or GitHub.");
        if (btn) btn.querySelector('.label')!.textContent = 'Sending…';
      }
      await this.auth.signInWithEmail(this.email, token);
      this.resendAt = Date.now() + RESEND_AFTER_S * 1000;
      this.error = null;
      this.sent = true;
      this.render();
      this.live.textContent = `Sign-in link sent to ${this.email}.`;
      focusFirst(this.d);
    } catch (err) {
      done();
      // Turnstile tokens work once: get a fresh one for the next try.
      this.captcha?.reset();
      const text = err instanceof Error ? err.message : "Couldn't send the link. Try again in a moment.";
      if (again) {
        this.live.textContent = text;
        this.body.querySelector('.sent-tips')?.insertAdjacentHTML('afterend', message('bad', text));
      } else this.showError(text);
    }
  }

  private async verifyCode() {
    const form = this.body.querySelector<HTMLFormElement>('.otp-form');
    const input = form?.querySelector<HTMLInputElement>('input[name=code]');
    const btn = form?.querySelector<HTMLButtonElement>('button[type=submit]') ?? null;
    if (!form || !input || btn?.disabled) return;
    const slot = form.querySelector('#otp-error')!;
    const code = input.value.replace(/\D/g, '');
    if (code.length !== CODE_LENGTH) {
      slot.innerHTML = message('bad', `Enter all ${CODE_LENGTH} digits from the email.`);
      input.setAttribute('aria-invalid', 'true');
      return input.focus();
    }
    const done = busy(btn, 'Checking…');
    input.readOnly = true;
    try {
      // No captcha here: Supabase checks it when the code is sent, not when it's used.
      await this.auth.verifyEmailCode(this.email, code);
      this.live.textContent = 'Signed in.';
      busy(btn, 'Signing in…');
      // Exactly like coming back from the link: a fresh boot picks up the session.
      location.assign('/');
    } catch (err) {
      done();
      input.readOnly = false;
      input.setAttribute('aria-invalid', 'true');
      slot.innerHTML = message('bad', err instanceof Error ? err.message : "That code didn't work. Try again.");
      input.select();
    }
  }

  private showError(text: string) {
    this.error = text;
    const slot = this.body.querySelector('#signin-error');
    const input = this.body.querySelector<HTMLInputElement>('input[name=email]');
    if (slot) slot.innerHTML = message('bad', text);
    input?.setAttribute('aria-invalid', 'true');
    input?.setAttribute('aria-describedby', 'signin-error');
  }
}
