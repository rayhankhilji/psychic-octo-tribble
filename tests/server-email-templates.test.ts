import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authTemplates } from '../server/email/auth-templates.ts';
import * as T from '../server/email/templates.ts';

const brand: T.Brand = { appUrl: 'https://tinytown.test', replies: true, supportEmail: null, postalAddress: null };
const NOW = Date.UTC(2026, 9, 12);

const numbers: T.DigestNumbers = {
  name: 'Acme',
  currency: 'usd',
  from: NOW - 7 * 86_400_000,
  to: NOW,
  fullWeek: true,
  revenue: { mrr: 4320, mrrChange: -80, customers: 120, customersChange: 0 },
  users: { value: 900, change: 12 },
  shipping: { releases: 2, releaseNames: ['v1.2', 'v1.3'], commits: 31 },
  built: [{ item: 'park', count: 2 }],
  movedHome: { tier: 2, choice: 'loft' },
  city: { treasury: 43_200_000, unhoused: 1 },
};
const unsub = { digest: 'https://tinytown.test/api/email/unsubscribe?token=a', all: 'https://tinytown.test/api/email/unsubscribe?token=b' };

const all: [string, T.Email][] = [
  ['welcome', T.welcome(brand, { interval: 'month' })],
  ['payment failed', T.paymentFailed(brand, { billingUrl: 'https://tinytown.test', viaPortal: false })],
  ['canceled', T.planCanceled(brand, { endsAt: NOW + 86_400_000 * 20, now: NOW })],
  ['canceled now', T.planCanceled(brand, { endsAt: null, now: NOW })],
  ['ended', T.planEnded(brand)],
  ['broken', T.connectionBroken(brand, { provider: 'github' })],
  ['deleted', T.accountDeleted(brand)],
  ['invited', T.accessInvited(brand, { email: 'a@example.com' })],
  ['digest', T.digest(brand, numbers, unsub)],
];

describe('email templates', () => {
  it.each(all)('%s: a complete, responsive, dark-aware email with a plain-text twin', (_name, e) => {
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.html.startsWith('<!doctype html>')).toBe(true);
    expect(e.html).toContain('<html lang="en"');
    expect(e.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(e.html).toContain('@media (prefers-color-scheme: dark)');
    expect(e.html).toContain('max-width:600px');
    expect(e.html).toContain('src="https://tinytown.test/email/header@2x.png"');
    expect(e.html).toContain('src="https://tinytown.test/email/header-night@2x.png"');
    expect(e.html).toContain('Reply to this email');
    // No scripts, no remote styles, no tracking pixels.
    expect(e.html).not.toMatch(/<script|<link|<iframe/i);
    // Plain text has no markup.
    expect(e.text).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(e.text.length).toBeGreaterThan(100);
  });

  it('escapes every interpolated value', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const invite = T.accessInvited(brand, { email: evil });
    expect(invite.html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
    expect(invite.html).not.toContain('<img src=x');
    const d = T.digest(brand, { ...numbers, name: evil, shipping: { releases: 1, releaseNames: [evil], commits: 0 }, built: [{ item: evil, count: 1 }] }, unsub);
    expect(d.html).not.toContain('<img src=x');
    expect(d.html.split('&lt;img src=x onerror=alert(1)&gt;').length).toBeGreaterThan(3);
  });

  it('only links to http(s) and mailto', () => {
    const e = T.paymentFailed(brand, { billingUrl: 'javascript:alert(1)', viaPortal: true });
    expect(e.html).not.toContain('javascript:');
    expect(e.html).toContain('href="https://tinytown.test/"');
    const support = T.planEnded({ ...brand, replies: false, supportEmail: 'help@tinytown.test' });
    expect(support.html).toContain('href="mailto:help@tinytown.test"');
  });

  it('keeps subjects to one clean line', () => {
    const e = T.render(brand, { subject: 'Hello\r\nBcc: everyone@example.com', preheader: '', title: 't', blocks: [], reason: 'r' });
    expect(e.subject).toBe('Hello Bcc: everyone@example.com');
  });

  it('the digest quotes the real numbers, signed, with words as well as colour', () => {
    const d = T.digest(brand, numbers, unsub);
    expect(d.subject).toBe('Your city this week: MRR down $80 to $4,320');
    expect(d.text).toContain('MRR: $4,320 (−$80)');
    expect(d.text).toContain('Paying customers: 120 (No change)');
    expect(d.text).toContain('Active users: 900 (+12)');
    expect(d.text).toContain('Releases this week: 2');
    expect(d.text).toContain('Pocket park × 2');
    expect(d.text).toContain('You moved into the Loft apartment');
    expect(d.text).toContain('$43.2M in the city budget');
    expect(d.text).toContain('1 user is still looking for a home');
    expect(d.text).toContain('Stop the weekly digest: https://tinytown.test/api/email/unsubscribe?token=a');
    expect(d.html).toContain('The 7 days to October 12');
  });

  it('the digest headline falls back to shipping, then to the truth', () => {
    expect(T.digestHeadline({ ...numbers, revenue: null })).toBe('2 releases shipped');
    expect(T.digestHeadline({ ...numbers, revenue: null, shipping: { releases: 0, releaseNames: [], commits: 1 } })).toBe('1 commit pushed');
    expect(T.digestHeadline({ ...numbers, revenue: null, shipping: null })).toBe('a quiet week');
    expect(T.digestHeadline({ ...numbers, revenue: { ...numbers.revenue!, mrrChange: 0 } })).toBe('MRR steady at $4,320');
  });

  it('shows the postal address only in non-essential mail', () => {
    const b = { ...brand, postalAddress: '548 Market St, San Francisco, CA 94104' };
    expect(T.digest(b, numbers, unsub).html).toContain('548 Market St');
    expect(T.welcome(b, { interval: 'year' }).html).not.toContain('548 Market St');
  });
});

describe('Supabase auth templates', () => {
  const dir = new URL('../supabase/templates/', import.meta.url);

  it.each(authTemplates().map((t) => [t.file, t] as const))('%s matches its source and uses Supabase’s variables', (file, t) => {
    if (process.env.UPDATE_EMAIL_TEMPLATES) writeFileSync(new URL(file, dir), t.html);
    // Regenerate with: UPDATE_EMAIL_TEMPLATES=1 npx vitest run tests/server-email-templates.test.ts
    expect(readFileSync(new URL(file, dir), 'utf8')).toBe(t.html);
    expect(t.html).toContain('{{ .SiteURL }}/email/header@2x.png');
    expect(t.html).not.toContain('.invalid');
    if (file === 'reauthentication.html') expect(t.html).toContain('{{ .Token }}');
    else expect(t.html).toContain('href="{{ .ConfirmationURL }}"');
    if (file === 'email_change.html') expect(t.html).toContain('{{ .NewEmail }}');
  });
});
