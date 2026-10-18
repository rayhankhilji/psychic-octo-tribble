import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  STATE_TTL_MS,
  decrypt,
  encrypt,
  githubAppJwt,
  safeEqual,
  signState,
  stripeSignatureHeader,
  verifyState,
  verifyStripeSignature,
} from '../server/crypto.ts';
import { readPem } from '../server/env.ts';

const enc = new TextEncoder();
const NOW = Date.UTC(2026, 9, 13, 12);
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { privateKey: GITHUB_PEM, publicKey: GITHUB_PUBLIC } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('Stripe webhook signatures', () => {
  const secret = 'whsec_abc';
  const payload = '{"id":"evt_1","type":"customer.subscription.updated"}';
  const t = NOW / 1000;

  it('accepts a valid signature', () => {
    expect(verifyStripeSignature(enc.encode(payload), stripeSignatureHeader(payload, secret, t), secret, NOW)).toBe(true);
  });

  it('accepts when any one of several v1 signatures matches (secret rotation)', () => {
    const good = stripeSignatureHeader(payload, secret, t).split(',')[1]!;
    const header = `t=${t},v1=${'0'.repeat(64)},${good},v0=ignored`;
    expect(verifyStripeSignature(enc.encode(payload), header, secret, NOW)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and garbage headers', () => {
    const header = stripeSignatureHeader(payload, secret, t);
    expect(verifyStripeSignature(enc.encode(payload.replace('evt_1', 'evt_2')), header, secret, NOW)).toBe(false);
    expect(verifyStripeSignature(enc.encode(payload), header, 'whsec_other', NOW)).toBe(false);
    expect(verifyStripeSignature(enc.encode(payload), null, secret, NOW)).toBe(false);
    expect(verifyStripeSignature(enc.encode(payload), 'v1=abc', secret, NOW)).toBe(false);
    expect(verifyStripeSignature(enc.encode(payload), `t=${t}`, secret, NOW)).toBe(false);
  });

  it('rejects stale and future timestamps beyond five minutes', () => {
    expect(verifyStripeSignature(enc.encode(payload), stripeSignatureHeader(payload, secret, t - 301), secret, NOW)).toBe(false);
    expect(verifyStripeSignature(enc.encode(payload), stripeSignatureHeader(payload, secret, t + 301), secret, NOW)).toBe(false);
    expect(verifyStripeSignature(enc.encode(payload), stripeSignatureHeader(payload, secret, t - 299), secret, NOW)).toBe(true);
  });
});

describe('OAuth state', () => {
  const secret = 'state-secret';
  const state = { user: 'u1', provider: 'stripe' as const, exp: NOW + STATE_TTL_MS, nonce: 'n1', live: true };

  it('round-trips', () => {
    expect(verifyState(signState(state, secret), secret, 'stripe', NOW)).toEqual(state);
  });

  it('rejects tampering, another secret, another provider and expiry', () => {
    const token = signState(state, secret);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...state, user: 'attacker' })).toString('base64url');
    expect(verifyState(`${forged}.${sig}`, secret, 'stripe', NOW)).toBeNull();
    expect(verifyState(`${body}.${sig}x`, secret, 'stripe', NOW)).toBeNull();
    expect(verifyState(token, 'other-secret', 'stripe', NOW)).toBeNull();
    expect(verifyState(token, secret, 'github', NOW)).toBeNull();
    expect(verifyState(token, secret, 'stripe', NOW + STATE_TTL_MS + 1)).toBeNull();
    expect(verifyState(null, secret, 'stripe', NOW)).toBeNull();
    expect(verifyState('not-a-token', secret, 'stripe', NOW)).toBeNull();
  });
});

describe('secrets at rest', () => {
  it('round-trips with AES-256-GCM and a fresh IV each time', () => {
    const a = encrypt('rt_secret_refresh_token', ENCRYPTION_KEY, 'u1:stripe');
    const b = encrypt('rt_secret_refresh_token', ENCRYPTION_KEY, 'u1:stripe');
    expect(a).not.toBe(b);
    expect(a).not.toContain('rt_secret');
    expect(decrypt(a, ENCRYPTION_KEY, 'u1:stripe')).toBe('rt_secret_refresh_token');
  });

  it("won't decrypt on another user's row, under another key, or after tampering", () => {
    const sealed = encrypt('secret', ENCRYPTION_KEY, 'u1:stripe');
    expect(() => decrypt(sealed, ENCRYPTION_KEY, 'u2:stripe')).toThrow();
    expect(() => decrypt(sealed, Buffer.alloc(32, 9).toString('base64'), 'u1:stripe')).toThrow();
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered!').toString('base64url');
    expect(() => decrypt(parts.join('.'), ENCRYPTION_KEY, 'u1:stripe')).toThrow();
  });

  it('insists on a 32-byte key', () => {
    expect(() => encrypt('x', Buffer.alloc(16).toString('base64'), 'c')).toThrow(/32 bytes/);
  });

  it('compares in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('GitHub App JWT', () => {
  it('is RS256-signed by the app key with a short, backdated lifetime', () => {
    const jwt = githubAppJwt('4242', GITHUB_PEM, NOW);
    const [head, payload, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims).toEqual({ iss: '4242', iat: NOW / 1000 - 60, exp: NOW / 1000 + 540 });
    expect(createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(GITHUB_PUBLIC, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('reads the private key pasted raw, with \\n escapes, or base64-encoded', () => {
    expect(readPem(GITHUB_PEM)).toBe(GITHUB_PEM.trim());
    expect(readPem(GITHUB_PEM.trim().replace(/\n/g, '\\n'))).toBe(GITHUB_PEM.trim());
    expect(readPem(Buffer.from(GITHUB_PEM).toString('base64'))).toBe(GITHUB_PEM.trim());
  });
});
