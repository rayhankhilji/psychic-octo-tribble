/**
 * Cloudflare Turnstile, the bot check on email sign-in (when the server's
 * config turns it on). The script loads from challenges.cloudflare.com only
 * when the sign-in dialog opens, and the widget stays invisible unless
 * Cloudflare actually needs the person to tick something.
 */

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function load(): Promise<TurnstileApi> {
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.append(s);
  });
  return loading;
}

/** One widget in one slot. `token()` waits for Cloudflare's answer; tokens are single-use, so `reset()` after each try. */
export class Captcha {
  private siteKey: string;
  private id: string | null = null;
  private current: string | null = null;
  private waiters: ((t: string | null) => void)[] = [];
  private failed = false;

  constructor(siteKey: string) {
    this.siteKey = siteKey;
  }

  /** Renders into `slot` (re-rendering the dialog makes a new slot; the old widget goes). */
  async mount(slot: HTMLElement) {
    try {
      const ts = await load();
      if (this.id) ts.remove(this.id);
      this.current = null;
      this.failed = false;
      if (!slot.isConnected) return;
      this.id = ts.render(slot, {
        sitekey: this.siteKey,
        theme: document.documentElement.dataset.theme === 'night' ? 'dark' : 'light',
        size: 'flexible',
        appearance: 'interaction-only',
        callback: (t: string) => this.settle(t),
        'expired-callback': () => (this.current = null),
        'error-callback': () => {
          this.failed = true;
          this.settle(null);
        },
      });
    } catch {
      this.failed = true;
      this.settle(null);
    }
  }

  private settle(t: string | null) {
    this.current = t;
    for (const w of this.waiters.splice(0)) w(t);
  }

  /** The token, waiting up to 20 s for Cloudflare. Null if the check couldn't run. */
  token(): Promise<string | null> {
    if (this.current) return Promise.resolve(this.current);
    if (this.failed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      window.setTimeout(() => {
        const i = this.waiters.indexOf(resolve);
        if (i >= 0) (this.waiters.splice(i, 1), resolve(null));
      }, 20_000);
    });
  }

  reset() {
    this.current = null;
    if (this.id && window.turnstile) window.turnstile.reset(this.id);
  }
}
