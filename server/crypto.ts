import { createCipheriv, createDecipheriv, createHash, createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';

/** Compares two strings without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual needs equal lengths; comparing against itself keeps the time flat.
  return x.length === y.length ? timingSafeEqual(x, y) : (timingSafeEqual(x, x), false);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 16) => randomBytes(bytes).toString('base64url');

// ─── Secrets at rest: AES-256-GCM ─────────────────────────────────────────

function aesKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).');
  return key;
}

/**
 * Encrypts a secret (a refresh token, an API key) for the database. `context`
 * (e.g. "user-id:stripe") is bound in as associated data, so a ciphertext
 * copied onto another user's row won't decrypt.
 */
export function encrypt(plain: string, keyBase64: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(keyBase64), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), data.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

function open(sealed: string, keyBase64: string, context: string): string {
  const [version, iv, data, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || data === undefined || !tag) throw new Error('Unreadable secret');
  const decipher = createDecipheriv('aes-256-gcm', aesKey(keyBase64), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Opens a sealed secret with the first key that fits, current key first
 * (`decryptionKeys()` in env.ts). `stale` says it needed an older key, so
 * the caller can seal it again under the current one; once nothing is stale,
 * TOKEN_ENCRYPTION_KEY_OLD can go. GCM's tag makes a wrong key fail loudly,
 * never decrypt to rubbish.
 */
export function openSecret(sealed: string, keys: string | readonly string[], context: string): { plain: string; stale: boolean } {
  const list = typeof keys === 'string' ? [keys] : keys;
  let failure: unknown = new Error('Unreadable secret');
  for (let i = 0; i < list.length; i++) {
    try {
      return { plain: open(sealed, list[i]!, context), stale: i > 0 };
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

export function decrypt(sealed: string, keys: string | readonly string[], context: string): string {
  return openSecret(sealed, keys, context).plain;
}

// ─── OAuth state: HMAC-signed, expiring ───────────────────────────────────

export interface OAuthState {
  /** Supabase user id the flow was started for. */
  user: string;
  provider: 'stripe' | 'github' | 'ga4';
  /** Expiry, ms since epoch. */
  exp: number;
  /** Random value also kept in an HttpOnly cookie, tying the callback to the browser that started it. */
  nonce: string;
  /** Stripe only: which mode's key exchanges the code. */
  live?: boolean;
}

export const STATE_TTL_MS = 10 * 60_000;

const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function signState(state: OAuthState, secret: string): string {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

/** The state if it is ours, untampered, for this provider and not expired; otherwise null. */
export function verifyState(token: string | null, secret: string, provider: OAuthState['provider'], now = Date.now()): OAuthState | null {
  if (!token || token.length > 2048) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined || !safeEqual(sig, hmac(secret, body))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
    if (s.provider !== provider || typeof s.user !== 'string' || typeof s.nonce !== 'string' || !(s.exp > now)) return null;
    return s;
  } catch {
    return null;
  }
}

// ─── Stripe webhooks ──────────────────────────────────────────────────────

export const WEBHOOK_TOLERANCE_S = 300;

/**
 * Checks a `Stripe-Signature` header against the raw request body: an
 * HMAC-SHA256 of `"{t}.{body}"` under the endpoint's signing secret, with
 * the timestamp no more than five minutes from now (replay protection).
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripeSignature(payload: Uint8Array, header: string | null, secret: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (t === null || sigs.length === 0) return false;
  if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(payload).digest('hex');
  // Check every signature (Stripe sends several while a secret is being rolled) without stopping early.
  let ok = false;
  for (const s of sigs) ok = safeEqual(s, expected) || ok;
  return ok;
}

/** Builds a header the way Stripe does, for tests and local tooling. */
export function stripeSignatureHeader(payload: string, secret: string, tSeconds: number): string {
  return `t=${tSeconds},v1=${createHmac('sha256', secret).update(`${tSeconds}.${payload}`).digest('hex')}`;
}

// ─── GitHub App JWT (RS256) ───────────────────────────────────────────────

/**
 * A short-lived JWT that authenticates as the GitHub App itself, used only
 * to mint installation tokens. Backdated a minute for clock drift; GitHub
 * allows at most ten minutes.
 */
export function githubAppJwt(issuer: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 9 * 60, iss: issuer })}`;
  const sig = createSign('RSA-SHA256').update(head).sign(privateKeyPem).toString('base64url');
  return `${head}.${sig}`;
}
