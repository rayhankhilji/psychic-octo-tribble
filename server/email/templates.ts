import { HOME_TIERS, ITEMS } from '../../src/game/catalog.ts';
import { money } from '../../src/game/economy.ts';
import { formatMoney } from '../../src/data/types.ts';

/**
 * Every email TinyTown sends, as functions returning `{ subject, html, text }`.
 *
 * Each email is a list of blocks rendered twice: as hand-built HTML (tables,
 * inline styles, one column that holds from 320px to 600px, light and dark)
 * and as plain text. Every interpolated value is escaped on the way into the
 * HTML, and every link must be http(s). The look follows the app: warm sand
 * paper, ink text, Golden Gate orange for the one thing to press.
 */

export interface Email {
  subject: string;
  html: string;
  text: string;
}

/** What every email needs to know about where it comes from. */
export interface Brand {
  /** e.g. https://tinytown.app, no trailing slash. */
  appUrl: string;
  /** Replies reach a person (EMAIL_REPLY_TO is set). */
  replies: boolean;
  supportEmail: string | null;
  /** Required by CAN-SPAM in non-essential mail; shown when set. */
  postalAddress: string | null;
}

// ─── Escaping ─────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** For text and attribute values in HTML. */
export function esc(s: string | number): string {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** Only http(s) and mailto links, escaped for an attribute. Anything else becomes the fallback. */
function href(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') return esc(u.toString());
  } catch {
    // fall through
  }
  return esc(fallback);
}

/** Subjects and plain-text lines: no control characters, no line breaks, nothing absurdly long. */
function oneLine(s: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ─── Blocks ───────────────────────────────────────────────────────────────

/** A run of text inside a paragraph: plain, bold, or a link. */
export type Inline = string | { b: string } | { a: string; href: string };

type Tone = 'up' | 'down' | 'flat';

export type Block =
  | { kind: 'p'; parts: Inline[] }
  | { kind: 'h2'; text: string }
  | { kind: 'steps'; items: { title: string; body: string }[] }
  | { kind: 'stats'; items: { label: string; value: string; change?: { text: string; tone: Tone } }[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'note'; parts: Inline[] }
  | { kind: 'code'; label: string; code: string }
  | { kind: 'rule' };

const p = (...parts: Inline[]): Block => ({ kind: 'p', parts });
const note = (...parts: Inline[]): Block => ({ kind: 'note', parts });
const button = (label: string, url: string): Block => ({ kind: 'button', label, url });

export interface Letter {
  subject: string;
  /** The grey line inbox lists show after the subject. */
  preheader: string;
  title: string;
  blocks: Block[];
  /** Why this person got this email. */
  reason: string;
  /** Non-essential mail only: one-click ways out. */
  unsubscribe?: { label: string; url: string }[];
}

// Palette (mirrors src/ui/brand.ts and the CSS tokens). Contrast is AA or better on both cards.
const C = {
  page: '#f5ecdb',
  card: '#fffaf0',
  tile: '#f8f1e4',
  line: '#e6d5b8',
  ink: '#1b2236',
  ink2: '#3a4157',
  ink3: '#5c6175',
  link: '#a83818',
  button: '#cc4420',
  up: '#1f6b43',
  down: '#b2321f',
};

const FONT = "Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = `'Bricolage Grotesque',${FONT}`;
const MONO = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function inlineHtml(parts: Inline[], appUrl: string): string {
  return parts
    .map((x) => {
      if (typeof x === 'string') return esc(x);
      if ('b' in x) return `<strong style="font-weight:600;">${esc(x.b)}</strong>`;
      return `<a class="link" href="${href(x.href, appUrl)}" style="color:${C.link};text-decoration:underline;overflow-wrap:anywhere;word-break:break-word;">${esc(x.a)}</a>`;
    })
    .join('');
}

function inlineText(parts: Inline[]): string {
  return parts.map((x) => (typeof x === 'string' ? x : 'b' in x ? x.b : `${x.a} (${x.href})`)).join('');
}

const P_STYLE = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.ink2};`;

function blockHtml(b: Block, appUrl: string): string {
  switch (b.kind) {
    case 'p':
      return `<p class="ink2" style="${P_STYLE}">${inlineHtml(b.parts, appUrl)}</p>`;
    case 'note':
      return `<p class="ink3" style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink3};">${inlineHtml(b.parts, appUrl)}</p>`;
    case 'h2':
      return `<h2 class="ink" style="margin:28px 0 12px;font-family:${DISPLAY};font-size:18px;line-height:1.3;font-weight:700;color:${C.ink};">${esc(b.text)}</h2>`;
    case 'rule':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="rule" style="border-top:1px solid ${C.line};font-size:0;line-height:0;height:24px;">&nbsp;</td></tr></table>`;
    case 'list':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${b.items
        .map(
          (item) =>
            `<tr><td width="20" valign="top" style="font-family:${FONT};font-size:16px;line-height:1.6;color:${C.button};">&bull;</td><td class="ink2" style="font-family:${FONT};font-size:16px;line-height:1.6;color:${C.ink2};padding-bottom:4px;">${esc(item)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'steps':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;">${b.items
        .map(
          (s, i) =>
            `<tr><td width="40" valign="top" style="padding:0 0 18px;"><div class="tile" style="width:28px;height:28px;border-radius:14px;background:${C.tile};border:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:28px;font-weight:700;text-align:center;color:${C.link};">${i + 1}</div></td><td valign="top" style="padding:3px 0 18px;"><div class="ink" style="font-family:${FONT};font-size:16px;line-height:1.4;font-weight:600;color:${C.ink};">${esc(s.title)}</div><div class="ink2" style="font-family:${FONT};font-size:15px;line-height:1.55;color:${C.ink2};padding-top:2px;">${esc(s.body)}</div></td></tr>`,
        )
        .join('')}</table>`;
    case 'stats': {
      const cell = (s: (typeof b.items)[number], left: boolean) => {
        const sign = s.change ? `<div style="font-family:${FONT};font-size:14px;line-height:1.4;font-weight:600;color:${s.change.tone === 'up' ? C.up : s.change.tone === 'down' ? C.down : C.ink3};padding-top:2px;" class="${s.change.tone === 'flat' ? 'ink3' : `tone-${s.change.tone}`}">${esc(s.change.text)}</div>` : '';
        return `<td class="stat" width="50%" valign="top" style="padding:0 ${left ? 6 : 0}px 12px ${left ? 0 : 6}px;"><div class="tile" style="background:${C.tile};border:1px solid ${C.line};border-radius:12px;padding:14px 16px;"><div class="ink3" style="font-family:${FONT};font-size:13px;line-height:1.4;color:${C.ink3};">${esc(s.label)}</div><div class="ink" style="font-family:${DISPLAY};font-size:24px;line-height:1.25;font-weight:700;color:${C.ink};padding-top:2px;">${esc(s.value)}</div>${sign}</div></td>`;
      };
      const rows: string[] = [];
      for (let i = 0; i < b.items.length; i += 2) {
        const pair = b.items.slice(i, i + 2);
        rows.push(`<tr>${pair.map((s, j) => cell(s, j === 0)).join('')}${pair.length === 1 ? '<td class="stat" width="50%"></td>' : ''}</tr>`);
      }
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;">${rows.join('')}</table>`;
    }
    case 'button':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;"><tr><td class="btn" style="border-radius:10px;background:${C.button};"><a href="${href(b.url, appUrl)}" style="display:inline-block;padding:14px 24px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(b.label)}</a></td></tr></table>`;
    case 'code':
      return `<p class="ink3" style="margin:8px 0 6px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink3};">${esc(b.label)}</p><div class="tile ink" style="display:inline-block;margin:0 0 16px;padding:12px 18px;border-radius:10px;background:${C.tile};border:1px solid ${C.line};font-family:${MONO};font-size:26px;line-height:1.2;font-weight:600;letter-spacing:0.18em;color:${C.ink};">${esc(b.code)}</div>`;
  }
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'p':
    case 'note':
      return inlineText(b.parts);
    case 'h2':
      return `${b.text}\n${'-'.repeat(Math.min(40, b.text.length))}`;
    case 'rule':
      return '---';
    case 'list':
      return b.items.map((i) => `- ${i}`).join('\n');
    case 'steps':
      return b.items.map((s, i) => `${i + 1}. ${s.title}\n   ${s.body}`).join('\n\n');
    case 'stats':
      return b.items.map((s) => `${s.label}: ${s.value}${s.change ? ` (${s.change.text})` : ''}`).join('\n');
    case 'button':
      return `${b.label}: ${b.url}`;
    case 'code':
      return `${b.label}\n\n    ${b.code}`;
  }
}

/** The dark-mode overrides, for clients that honour them (Apple Mail, iOS, Outlook.com, some Android). */
const DARK = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .bg { background:#121827 !important; }
    .card { background:#1b2236 !important; border-color:#2f3854 !important; }
    .tile { background:#232b45 !important; border-color:#2f3854 !important; }
    .ink { color:#f5ecdb !important; }
    .ink2 { color:#cfd2dc !important; }
    .ink3 { color:#a7abba !important; }
    .link { color:#ff9c74 !important; }
    .rule { border-color:#2f3854 !important; }
    .tone-up { color:#6fd39e !important; }
    .tone-down { color:#ff8a7a !important; }
  }
  [data-ogsc] .ink { color:#f5ecdb !important; }
  [data-ogsc] .ink2 { color:#cfd2dc !important; }
  [data-ogsc] .ink3 { color:#a7abba !important; }
  [data-ogsc] .link { color:#ff9c74 !important; }
  [data-ogsb] .card { background:#1b2236 !important; }
  [data-ogsb] .bg { background:#121827 !important; }`;

const RESPONSIVE = `
  body { margin:0 !important; padding:0 !important; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media (max-width:600px) {
    .px { padding-left:20px !important; padding-right:20px !important; }
    .h1 { font-size:24px !important; }
  }
  @media (max-width:480px) {
    .stat { display:block !important; width:100% !important; box-sizing:border-box; padding-left:0 !important; padding-right:0 !important; }
  }`;

/**
 * The page every email shares. Raw `title`/`preheader` strings are escaped
 * here; `content` is already HTML.
 */
export function shell(opts: { appUrl: string; logoUrl: string; title: string; preheader: string; content: string; footer: string; subject: string }): string {
  const home = href(opts.appUrl, opts.appUrl);
  // Zero-width padding stops inbox previews running on into the body text.
  const spacer = '&#847;&zwnj;&nbsp;'.repeat(40);
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(opts.subject)}</title>
<style>${RESPONSIVE}${DARK}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};">${esc(opts.preheader)}${spacer}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${C.page};">
<tr><td align="center" style="padding:32px 12px 40px;">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td class="px" style="padding:0 36px 20px;">
<a href="${home}" style="text-decoration:none;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding-right:10px;"><img src="${esc(opts.logoUrl)}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border-radius:8px;"></td>
<td valign="middle" class="ink" style="font-family:${DISPLAY};font-size:20px;line-height:32px;font-weight:800;letter-spacing:-0.02em;color:${C.ink};">TinyTown</td>
</tr></table></a>
</td></tr>
<tr><td class="card px" style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:32px 36px 24px;">
<h1 class="ink h1" style="margin:0 0 16px;font-family:${DISPLAY};font-size:27px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${C.ink};">${esc(opts.title)}</h1>
${opts.content}
</td></tr>
<tr><td class="px" style="padding:24px 36px 0;">
${opts.footer}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

const FOOT_STYLE = `margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:1.55;color:${C.ink3};`;

function contactLine(brand: Brand): Inline[] | null {
  if (brand.replies) return ['Questions? Reply to this email and a person will read it.'];
  if (brand.supportEmail) return ['Questions? Write to ', { a: brand.supportEmail, href: `mailto:${brand.supportEmail}` }, '.'];
  return null;
}

/** Renders a letter into the finished email. */
export function render(brand: Brand, letter: Letter): Email {
  const subject = oneLine(letter.subject);
  const contact = contactLine(brand);
  const foot: string[] = [];
  const footText: string[] = [];
  if (contact) {
    foot.push(`<p class="ink3" style="${FOOT_STYLE}">${inlineHtml(contact, brand.appUrl)}</p>`);
    footText.push(inlineText(contact));
  }
  foot.push(`<p class="ink3" style="${FOOT_STYLE}">${esc(letter.reason)}</p>`);
  footText.push(letter.reason);
  if (letter.unsubscribe?.length) {
    foot.push(
      `<p class="ink3" style="${FOOT_STYLE}">${letter.unsubscribe
        .map((u) => `<a class="link" href="${href(u.url, brand.appUrl)}" style="color:${C.link};text-decoration:underline;">${esc(u.label)}</a>`)
        .join(' &nbsp;&middot;&nbsp; ')}</p>`,
    );
    for (const u of letter.unsubscribe) footText.push(`${u.label}: ${u.url}`);
    if (brand.postalAddress) {
      foot.push(`<p class="ink3" style="${FOOT_STYLE}">${esc(brand.postalAddress)}</p>`);
      footText.push(brand.postalAddress);
    }
  }
  const host = hostOf(brand.appUrl);
  foot.push(`<p class="ink3" style="${FOOT_STYLE}">TinyTown &middot; <a class="link" href="${href(brand.appUrl, brand.appUrl)}" style="color:${C.ink3};text-decoration:none;">${esc(host)}</a></p>`);
  footText.push(`TinyTown · ${brand.appUrl}`);

  const html = shell({
    appUrl: brand.appUrl,
    logoUrl: `${brand.appUrl}/apple-touch-icon.png`,
    title: letter.title,
    preheader: oneLine(letter.preheader, 160),
    subject,
    content: letter.blocks.map((b) => blockHtml(b, brand.appUrl)).join('\n'),
    footer: foot.join('\n'),
  });
  const text = [letter.title, '', ...letter.blocks.map(blockText).flatMap((t) => [t, '']), '--', ...footText].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { subject, html, text };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ─── Dates ────────────────────────────────────────────────────────────────

const LONG = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const SHORT = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
export const longDate = (t: number) => LONG.format(new Date(t));
export const shortDate = (t: number) => SHORT.format(new Date(t));

// ─── Lifecycle emails ─────────────────────────────────────────────────────

const PROVIDER_NAMES = { stripe: 'Stripe', github: 'GitHub', posthog: 'PostHog' } as const;

export function welcome(brand: Brand, x: { interval: 'month' | 'year' }): Email {
  return render(brand, {
    subject: 'Welcome to TinyTown',
    preheader: 'Your plan is active. Connect Stripe and your city starts growing.',
    title: 'You’re in. Let’s build your city.',
    blocks: [
      p(`Thanks for joining TinyTown. Your ${x.interval === 'year' ? 'yearly' : 'monthly'} plan is active, and your piece of the Bay is waiting for its first founder.`),
      { kind: 'h2', text: 'What happens next' },
      {
        kind: 'steps',
        items: [
          { title: 'Connect Stripe', body: 'Install the TinyTown app on your Stripe account. It’s read-only. Every $1 of MRR becomes $10,000 to build with, and your last 90 days of revenue arrive as a grand opening fund.' },
          { title: 'Connect GitHub (optional)', body: 'Pick a repository and every release you ship shows up in town.' },
          { title: 'Build', body: 'Homes, parks, towers. Every user needs a place to live, so the city grows as fast as your startup does. Your own house climbs from a hacker house to the moon.' },
        ],
      },
      button('Open your city', brand.appUrl),
    ],
    reason: 'You’re getting this because you started a TinyTown plan.',
  });
}

export function paymentFailed(brand: Brand, x: { billingUrl: string; viaPortal: boolean }): Email {
  return render(brand, {
    subject: 'Your TinyTown payment didn’t go through',
    preheader: 'Nothing changes yet: your city keeps running while Stripe tries again.',
    title: 'Your last payment didn’t go through',
    blocks: [
      p('We couldn’t take your latest TinyTown payment. It happens: cards expire, banks get cautious.'),
      p('Nothing changes yet. Your city keeps running while Stripe tries the card again over the next few days.'),
      x.viaPortal
        ? p('To sort it now, update your card in the billing portal. It takes a minute.')
        : p('To sort it now, open TinyTown and choose Update card. It takes a minute.'),
      button('Update your card', x.billingUrl),
      note('If the retries don’t go through, your plan ends and your city pauses. Nothing you built is deleted, and picking a plan again brings it straight back.'),
    ],
    reason: 'You’re getting this because a payment for your TinyTown plan failed.',
  });
}

export function planCanceled(brand: Brand, x: { endsAt: number | null; now: number }): Email {
  const later = x.endsAt !== null && x.endsAt > x.now;
  return render(brand, {
    subject: later ? 'Your TinyTown plan won’t renew' : 'Your TinyTown plan is canceled',
    preheader: later ? `You keep full access until ${longDate(x.endsAt!)}.` : 'Your city is saved if you ever want it back.',
    title: later ? 'Your plan won’t renew' : 'Your plan is canceled',
    blocks: later
      ? [
          p('Your TinyTown plan is canceled. You keep full access until ', { b: longDate(x.endsAt!) }, ', and you won’t be charged again.'),
          p('After that your city pauses. Nothing is deleted: pick a plan again any time and it opens right where you left it.'),
          p('Changed your mind? Turn renewal back on from Account in TinyTown before then.'),
          button('Open TinyTown', brand.appUrl),
        ]
      : [
          p('Your TinyTown plan is canceled, and you won’t be charged again.'),
          p('Your city is paused, not gone. Everything you built is saved: pick a plan again any time and it opens right where you left it.'),
          button('Open TinyTown', brand.appUrl),
        ],
    reason: 'You’re getting this because your TinyTown plan was canceled.',
  });
}

export function planEnded(brand: Brand): Email {
  return render(brand, {
    subject: 'Your TinyTown plan has ended',
    preheader: 'Your city is paused and saved, exactly as you left it.',
    title: 'Your city is paused',
    blocks: [
      p('Your TinyTown plan has ended, so your city is paused.'),
      p('Everything is saved: the buildings, your house, the history. Pick a plan any time and it opens right where you left it, with everything your startup earned in the meantime.'),
      button('Pick a plan', brand.appUrl),
      note('Rather we deleted it all? You can delete your account from Account in TinyTown.'),
    ],
    reason: 'You’re getting this because your TinyTown plan ended.',
  });
}

export function connectionBroken(brand: Brand, x: { provider: keyof typeof PROVIDER_NAMES }): Email {
  const name = PROVIDER_NAMES[x.provider];
  const why = {
    stripe: 'This usually means the TinyTown app was uninstalled from your Stripe account, or its access was revoked.',
    github: 'This usually means the TinyTown GitHub App was uninstalled, or it lost access to your repository.',
    posthog: 'This usually means your PostHog key was rotated or deleted.',
  }[x.provider];
  const what = {
    stripe: 'Until you reconnect, your city can’t see new revenue or customers.',
    github: 'Until you reconnect, new releases won’t show up in town.',
    posthog: 'Until you reconnect, your active-user count won’t update.',
  }[x.provider];
  return render(brand, {
    subject: `Reconnect ${name} to keep your city growing`,
    preheader: `TinyTown lost its connection to ${name}.`,
    title: `Reconnect ${name}`,
    blocks: [p(`TinyTown lost its connection to ${name}. ${why}`), p(`${what} Nothing you built is lost.`), button(`Reconnect ${name}`, brand.appUrl), note('In TinyTown, open Account and choose Reconnect.')],
    reason: `You’re getting this because your TinyTown city is connected to ${name}.`,
  });
}

export function accountDeleted(brand: Brand): Email {
  return render(brand, {
    subject: 'Your TinyTown account is deleted',
    preheader: 'Your city, connections and saved metrics are gone, as you asked.',
    title: 'Your account is deleted',
    blocks: [
      p('As you asked, your TinyTown account is deleted. Your plan is canceled, your Stripe, GitHub and PostHog connections are removed, and your city and saved metrics are erased.'),
      p('Invoices for past payments stay with Stripe, which keeps them for tax records.'),
      note('Didn’t ask for this? Reply to this email straight away.'),
      p('Thanks for building with us. You’re welcome back any time.'),
    ],
    reason: 'You’re getting this to confirm your TinyTown account was deleted. It’s the last email we’ll send you.',
  });
}

export function accessInvited(brand: Brand, x: { email: string }): Email {
  return render(brand, {
    subject: 'Your spot in TinyTown is open',
    preheader: 'You joined the waitlist. Your city is ready to be built.',
    title: 'Your spot is open',
    blocks: [
      p('You joined the TinyTown waitlist, and your spot is open now. Sign in with this address, ', { b: x.email }, ', and your city is waiting.'),
      p('TinyTown turns your startup’s real numbers into a little San Francisco Bay. Every $1 of MRR is $10,000 to build with, every user needs a home, and your own house climbs from a hacker house to the moon.'),
      button('Claim your spot', brand.appUrl),
    ],
    reason: 'You’re getting this because you joined the TinyTown waitlist.',
  });
}

// ─── The weekly digest ────────────────────────────────────────────────────

/** Real numbers for one founder's week. Every figure comes from their own timeline and saved actions. */
export interface DigestNumbers {
  name: string;
  currency: string;
  /** The first and last snapshot days of the window (ms, UTC). */
  from: number;
  to: number;
  /** True when the window is a full seven days. */
  fullWeek: boolean;
  revenue: { mrr: number; mrrChange: number; customers: number; customersChange: number } | null;
  users: { value: number; change: number } | null;
  shipping: { releases: number; releaseNames: string[]; commits: number } | null;
  /** Build actions this week, by item id, with counts. */
  built: { item: string; count: number }[];
  /** A home the founder moved into this week: tier and option ids. */
  movedHome: { tier: number; choice: string } | null;
  /** The city at the end of the window, from the same replay the game runs. */
  city: { treasury: number; unhoused: number } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function signed(n: number, fmt: (v: number) => string): string {
  return n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : 'No change';
}
const tone = (n: number): Tone => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

/** "MRR up $120 to $4,320": the subject's lead, from the most important real number we have. */
export function digestHeadline(d: DigestNumbers): string {
  const m = (v: number) => formatMoney(v, d.currency);
  if (d.revenue) {
    const { mrr, mrrChange } = d.revenue;
    if (mrrChange > 0) return `MRR up ${m(mrrChange)} to ${m(mrr)}`;
    if (mrrChange < 0) return `MRR down ${m(-mrrChange)} to ${m(mrr)}`;
    return `MRR steady at ${m(mrr)}`;
  }
  if (d.shipping?.releases) return `${plural(d.shipping.releases, 'release')} shipped`;
  if (d.shipping?.commits) return `${plural(d.shipping.commits, 'commit')} pushed`;
  return 'a quiet week';
}

function itemName(id: string): string {
  return ITEMS.get(id)?.name ?? id;
}

function homeName(tier: number, choice: string): string {
  return HOME_TIERS[tier]?.options.find((o) => o.id === choice)?.name ?? 'a new home';
}

export function digest(brand: Brand, d: DigestNumbers, unsubscribe: { digest: string; all: string }): Email {
  const m = (v: number) => formatMoney(v, d.currency);
  const span = d.fullWeek ? `The 7 days to ${shortDate(d.to)}` : `${shortDate(d.from)} to ${shortDate(d.to)}`;
  const blocks: Block[] = [note(`${span}, from your own numbers.`)];

  const stats: Extract<Block, { kind: 'stats' }>['items'] = [];
  if (d.revenue) {
    stats.push({ label: 'MRR', value: m(d.revenue.mrr), change: { text: signed(d.revenue.mrrChange, m), tone: tone(d.revenue.mrrChange) } });
    stats.push({ label: 'Paying customers', value: d.revenue.customers.toLocaleString('en-US'), change: { text: signed(d.revenue.customersChange, (v) => v.toLocaleString('en-US')), tone: tone(d.revenue.customersChange) } });
  }
  if (d.users) stats.push({ label: 'Active users', value: d.users.value.toLocaleString('en-US'), change: { text: signed(d.users.change, (v) => v.toLocaleString('en-US')), tone: tone(d.users.change) } });
  if (d.shipping) {
    stats.push({ label: 'Releases this week', value: d.shipping.releases.toLocaleString('en-US') });
    stats.push({ label: 'Commits this week', value: d.shipping.commits.toLocaleString('en-US') });
  }
  if (stats.length) blocks.push({ kind: 'stats', items: stats });

  if (d.shipping?.releaseNames.length) {
    blocks.push({ kind: 'h2', text: 'Shipped' });
    blocks.push({ kind: 'list', items: d.shipping.releaseNames });
  }

  blocks.push({ kind: 'h2', text: 'Your city' });
  const builtLines = d.built.map((b) => (b.count > 1 ? `${itemName(b.item)} × ${b.count}` : itemName(b.item)));
  if (d.movedHome) builtLines.push(`You moved into the ${homeName(d.movedHome.tier, d.movedHome.choice)}`);
  if (builtLines.length) {
    blocks.push(p('This week you built:'));
    blocks.push({ kind: 'list', items: builtLines });
  } else {
    blocks.push(p('Nothing new went up this week.'));
  }
  if (d.city) {
    blocks.push(p('You have ', { b: money(d.city.treasury) }, ' in the city budget to spend.'));
    if (d.city.unhoused > 0) blocks.push(p({ b: plural(d.city.unhoused, 'user') }, ` ${d.city.unhoused === 1 ? 'is' : 'are'} still looking for a home. Build housing before the city starts to fade.`));
  }
  blocks.push(button('Open your city', brand.appUrl));

  return render(brand, {
    subject: `Your city this week: ${digestHeadline(d)}`,
    preheader: `${span}: what changed in ${d.name}.`,
    title: 'Your city this week',
    blocks,
    reason: 'You’re getting this weekly summary because you have a TinyTown plan.',
    unsubscribe: [
      { label: 'Stop the weekly digest', url: unsubscribe.digest },
      { label: 'Unsubscribe from all non-essential email', url: unsubscribe.all },
    ],
  });
}

// ─── The unsubscribe page ─────────────────────────────────────────────────

/** A small page in the same look, for the unsubscribe link. `form` posts back to resubscribe. */
export function page(opts: { appUrl: string; title: string; body: string[]; form?: { action: string; label: string } }): string {
  const content = [
    ...opts.body.map((b) => `<p class="ink2" style="${P_STYLE}">${esc(b)}</p>`),
    opts.form
      ? `<form method="post" action="${esc(opts.form.action)}" style="margin:24px 0 8px;"><input type="hidden" name="action" value="resubscribe"><button type="submit" style="appearance:none;border:0;cursor:pointer;border-radius:10px;background:${C.button};padding:13px 22px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#fff;">${esc(opts.form.label)}</button></form>`
      : '',
    `<p class="ink3" style="margin:16px 0 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink3};"><a class="link" href="${href(opts.appUrl, '/')}" style="color:${C.link};">Back to TinyTown</a></p>`,
  ].join('\n');
  return shell({ appUrl: opts.appUrl, logoUrl: '/apple-touch-icon.png', title: opts.title, preheader: '', subject: `${opts.title} · TinyTown`, content, footer: '' });
}
