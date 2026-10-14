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
  /** A `lead` stat gets the whole row and a big figure; the rest sit two to a row. */
  | { kind: 'stats'; items: { label: string; value: string; change?: { text: string; tone: Tone }; lead?: boolean }[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'note'; parts: Inline[] }
  /** Something to act on, on a sun-washed panel. */
  | { kind: 'callout'; parts: Inline[] }
  | { kind: 'code'; label: string; code: string }
  /** A picture inside the text column, 2× pixels for a 518×`height` slot. HTML only: the plain text skips it. */
  | { kind: 'image'; src: string; alt: string; height: number; caption?: string }
  /** The tear-off end of a ticket: a perforation, then a few labelled facts side by side. */
  | { kind: 'stub'; items: { label: string; value: string }[] }
  | { kind: 'rule' };

const p = (...parts: Inline[]): Block => ({ kind: 'p', parts });
const note = (...parts: Inline[]): Block => ({ kind: 'note', parts });
const button = (label: string, url: string): Block => ({ kind: 'button', label, url });

export interface Letter {
  subject: string;
  /** The grey line inbox lists show after the subject. */
  preheader: string;
  /** A few words above the title, in small capitals: what kind of email this is. */
  eyebrow?: string;
  title: string;
  blocks: Block[];
  /** Why this person got this email. */
  reason: string;
  /** Non-essential mail only: one-click ways out. */
  unsubscribe?: { label: string; url: string }[];
}

// Palette (mirrors src/ui/brand.ts and the CSS tokens). Text is AA or better on the card and on tiles.
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
  gate: '#e5512b',
  up: '#1f6b43',
  upSoft: '#e0e9d6',
  down: '#b2321f',
  downSoft: '#f6e0d3',
  sunSoft: '#fbedc9',
  sunLine: '#f1d58f',
  sunInk: '#6e4800',
};

// Email clients can't load our fonts, so each stack names the brand face
// first (for the few clients that have it) and falls back to the system's
// best sans. Headings get the weight and tight tracking that make the
// system face read as a display cut.
const SYSTEM = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT = `Geist,${SYSTEM}`;
const DISPLAY = `'Bricolage Grotesque',${SYSTEM}`;
const MONO = "'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const NUM = 'font-variant-numeric:tabular-nums;font-feature-settings:"tnum";';

/** The text column: a 600px card less its border and 40px of padding a side. */
const COLUMN = 518;

/** Small capitals in Geist Mono, as the app's labels are. */
const label = (color: string, size = 11.5) => `font-family:${MONO};font-size:${size}px;line-height:1.4;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${color};`;

function inlineHtml(parts: Inline[], appUrl: string): string {
  return parts
    .map((x) => {
      if (typeof x === 'string') return esc(x);
      if ('b' in x) return `<strong class="ink" style="font-weight:650;color:${C.ink};">${esc(x.b)}</strong>`;
      return `<a class="link" href="${href(x.href, appUrl)}" style="color:${C.link};text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere;word-break:break-word;">${esc(x.a)}</a>`;
    })
    .join('');
}

function inlineText(parts: Inline[]): string {
  return parts.map((x) => (typeof x === 'string' ? x : 'b' in x ? x.b : `${x.a} (${x.href})`)).join('');
}

const P_STYLE = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.65;color:${C.ink2};`;
const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

function delta(change: { text: string; tone: Tone }, size: number): string {
  if (change.tone === 'flat') return `<span class="ink3" style="font-family:${FONT};font-size:${size}px;line-height:1.4;font-weight:500;color:${C.ink3};">${esc(change.text)}</span>`;
  const up = change.tone === 'up';
  return `<span class="tone-${change.tone}" style="display:inline-block;padding:2px 9px;border-radius:999px;background:${up ? C.upSoft : C.downSoft};font-family:${FONT};font-size:${size}px;line-height:1.45;font-weight:650;${NUM}color:${up ? C.up : C.down};white-space:nowrap;">${esc(change.text)}</span>`;
}

/** A bulletproof button: a rounded VML shape for desktop Outlook, a padded link everywhere else. */
function buttonHtml(label: string, url: string): string {
  const width = Math.round(label.length * 9.2 + 76);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 12px;"><tr><td>
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:50px;v-text-anchor:middle;width:${width}px;" arcsize="24%" stroke="f" fillcolor="${C.button}"><w:anchorlock/><center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:bold;">${esc(label)} &rarr;</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a class="btn" href="${url}" style="display:inline-block;padding:15px 26px;border-radius:12px;background:${C.button};font-family:${FONT};font-size:16px;line-height:20px;font-weight:650;letter-spacing:-0.005em;color:#ffffff;text-decoration:none;box-shadow:inset 0 1px 0 rgba(255,255,255,0.18),0 1px 2px rgba(27,34,54,0.08),0 6px 14px -6px rgba(184,60,28,0.55);">${esc(label)}&nbsp;&nbsp;&rarr;</a><!--<![endif]-->
</td></tr></table>`;
}

function blockHtml(b: Block, appUrl: string): string {
  switch (b.kind) {
    case 'p':
      return `<p class="ink2" style="${P_STYLE}">${inlineHtml(b.parts, appUrl)}</p>`;
    case 'note':
      return `<p class="ink3" style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:1.6;color:${C.ink3};">${inlineHtml(b.parts, appUrl)}</p>`;
    case 'callout':
      return `<table ${TABLE} style="margin:4px 0 16px;"><tr><td class="callout" style="padding:14px 18px;border-radius:12px;background:${C.sunSoft};border:1px solid ${C.sunLine};font-family:${FONT};font-size:15px;line-height:1.6;color:${C.sunInk};">${inlineHtml(b.parts, appUrl)}</td></tr></table>`;
    case 'h2':
      return `<h2 class="ink" style="margin:32px 0 12px;font-family:${DISPLAY};font-size:19px;line-height:1.3;font-weight:800;letter-spacing:-0.02em;color:${C.ink};">${esc(b.text)}</h2>`;
    case 'rule':
      return `<table ${TABLE}><tr><td class="rule" style="border-top:1px solid ${C.line};font-size:0;line-height:0;height:24px;">&nbsp;</td></tr></table>`;
    case 'list':
      return `<table ${TABLE} style="margin:0 0 16px;">${b.items
        .map(
          (item) =>
            `<tr><td width="22" valign="top" style="padding-top:1px;font-family:${FONT};font-size:10px;line-height:25px;color:${C.gate};">&#9670;</td><td class="ink2" style="font-family:${FONT};font-size:16px;line-height:1.6;color:${C.ink2};padding-bottom:6px;">${esc(item)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'steps':
      return `<table ${TABLE} style="margin:4px 0 8px;">${b.items
        .map(
          (s, i) =>
            `<tr><td width="44" valign="top" style="padding:0 0 20px;"><div class="tile link" style="width:30px;height:30px;border-radius:9px;background:${C.tile};border:1px solid ${C.line};font-family:${MONO};font-size:13px;line-height:30px;font-weight:600;text-align:center;color:${C.link};">${i + 1}</div></td><td valign="top" style="padding:4px 0 20px;"><div class="ink" style="font-family:${FONT};font-size:16px;line-height:1.4;font-weight:650;color:${C.ink};">${esc(s.title)}</div><div class="ink2" style="font-family:${FONT};font-size:15px;line-height:1.6;color:${C.ink2};padding-top:3px;">${esc(s.body)}</div></td></tr>`,
        )
        .join('')}</table>`;
    case 'stats': {
      const tile = (s: (typeof b.items)[number], big: boolean) =>
        `<div class="tile${big ? '' : ' tile-pad'}" style="background:${C.tile};border:1px solid ${C.line};border-radius:14px;padding:${big ? '18px 20px 20px' : '14px 16px 16px'};"><div class="ink3" style="${label(C.ink3)}">${esc(s.label)}</div><div class="ink" style="font-family:${DISPLAY};font-size:${big ? 44 : 28}px;line-height:1.1;font-weight:800;letter-spacing:-0.03em;${NUM}color:${C.ink};padding-top:${big ? 8 : 6}px;">${esc(s.value)}</div>${s.change ? `<div style="padding-top:${big ? 10 : 8}px;">${delta(s.change, big ? 14 : 13)}</div>` : ''}</div>`;
      const rows: string[] = [];
      const rest = b.items.filter((s) => !s.lead);
      for (const s of b.items.filter((s) => s.lead)) rows.push(`<tr><td colspan="2" style="padding:0 0 12px;">${tile(s, true)}</td></tr>`);
      for (let i = 0; i < rest.length; i += 2) {
        const pair = rest.slice(i, i + 2);
        if (pair.length === 1) rows.push(`<tr><td colspan="2" style="padding:0 0 12px;">${tile(pair[0]!, false)}</td></tr>`);
        else rows.push(`<tr>${pair.map((s, j) => `<td class="stat" width="50%" valign="top" style="padding:0 ${j === 0 ? 6 : 0}px 12px ${j === 0 ? 0 : 6}px;">${tile(s, false)}</td>`).join('')}</tr>`);
      }
      return `<table ${TABLE} style="margin:4px 0 12px;">${rows.join('')}</table>`;
    }
    case 'button':
      return buttonHtml(b.label, href(b.url, appUrl));
    case 'code':
      return `<p class="ink3" style="margin:8px 0 8px;${label(C.ink3, 12)}">${esc(b.label)}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td class="tile ink" style="padding:14px 22px 14px 26px;border-radius:14px;background:${C.tile};border:1px solid ${C.line};font-family:${MONO};font-size:32px;line-height:1.15;font-weight:600;letter-spacing:0.22em;${NUM}color:${C.ink};">${esc(b.code)}</td></tr></table>`;
    case 'image': {
      const src = href(b.src, `${appUrl}/email/header@2x.png`);
      const caption = b.caption ? `<p class="ink3" style="margin:10px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.ink3};">${esc(b.caption)}</p>` : '';
      return `<table ${TABLE} style="margin:8px 0 22px;"><tr><td><img class="frame" src="${src}" width="${COLUMN}" height="${b.height}" alt="${esc(b.alt)}" style="display:block;width:100%;max-width:${COLUMN}px;height:auto;border:1px solid ${C.line};border-radius:12px;background:${C.tile};font-family:${FONT};font-size:14px;color:${C.ink3};">${caption}</td></tr></table>`;
    }
    case 'stub': {
      const cells = b.items
        .map((s, i) => `<td class="stack" valign="top" width="${Math.floor(100 / b.items.length)}%" style="padding:16px ${i < b.items.length - 1 ? 16 : 0}px 0 0;"><div class="link" style="${label(C.link, 11)}">${esc(s.label)}</div><div class="ink" style="padding-top:4px;font-family:${FONT};font-size:15px;line-height:1.45;font-weight:650;color:${C.ink};overflow-wrap:anywhere;word-break:break-word;">${esc(s.value)}</div></td>`)
        .join('');
      return `<table ${TABLE} style="margin:6px 0 4px;"><tr><td colspan="${b.items.length}" class="perf" style="border-top:2px dashed ${C.line};font-size:0;line-height:0;height:0;">&nbsp;</td></tr><tr>${cells}</tr></table>`;
    }
  }
}

function blockText(b: Block): string {
  switch (b.kind) {
    case 'p':
    case 'note':
    case 'callout':
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
    case 'stub':
      return b.items.map((s) => `${s.label}: ${s.value}`).join('\n');
    case 'button':
      return `${b.label}: ${b.url}`;
    case 'code':
      return `${b.label}\n\n    ${b.code}`;
    case 'image':
      return '';
  }
}

/**
 * Dark mode, for clients that honour it (Apple Mail, iOS Mail, Outlook for
 * Mac and Outlook.com, some Android). The night masthead swaps in for the day
 * one. Gmail ignores all of this and inverts colours itself, which is why the
 * masthead is an opaque picture and nothing important is a dark-on-clear PNG.
 */
const DARK = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .bg { background:#0f1424 !important; }
    .card { background:#161c2f !important; border-color:#283049 !important; }
    .tile { background:#1d2439 !important; border-color:#283049 !important; }
    .frame { border-color:#283049 !important; }
    .ink { color:#f6eedf !important; }
    .ink2 { color:#c8c2b6 !important; }
    .ink3 { color:#a3a1af !important; }
    .link { color:#ff8a62 !important; }
    .rule, .perf { border-color:#283049 !important; }
    .callout { background:#2b2a26 !important; border-color:#4a4029 !important; color:#f6cf7d !important; }
    .tone-up { color:#63d396 !important; background:#173327 !important; }
    .tone-down { color:#ff9a88 !important; background:#3a1f22 !important; }
    .day-only { display:none !important; max-height:0 !important; overflow:hidden !important; }
    .night-only { display:block !important; max-height:none !important; overflow:visible !important; }
  }`;

// Outlook.com's own dark mode marks the page with these attributes. A separate
// style block, so a client that trips on attribute selectors drops only this one.
const OUTLOOK_DARK = `
  [data-ogsc] .ink { color:#f6eedf !important; }
  [data-ogsc] .ink2 { color:#c8c2b6 !important; }
  [data-ogsc] .ink3 { color:#a3a1af !important; }
  [data-ogsc] .link { color:#ff8a62 !important; }
  [data-ogsb] .card { background:#161c2f !important; }
  [data-ogsb] .tile { background:#1d2439 !important; }
  [data-ogsb] .bg { background:#0f1424 !important; }
  [data-ogsc] .day-only { display:none !important; }
  [data-ogsc] .night-only { display:block !important; max-height:none !important; }`;

const RESPONSIVE = `
  body { margin:0 !important; padding:0 !important; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  .btn:hover { background:#b93d1c !important; }
  @media (max-width:600px) {
    .outer { padding:16px 10px 32px !important; }
    .px { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:26px !important; }
  }
  @media (max-width:480px) {
    .stack { display:block !important; width:100% !important; box-sizing:border-box; padding-left:0 !important; padding-right:0 !important; }
    .tile-pad { padding:12px 14px 14px !important; }
  }
  @media (max-width:340px) {
    .stat { display:block !important; width:100% !important; box-sizing:border-box; padding-left:0 !important; padding-right:0 !important; }
  }`;

/**
 * The page every email shares: a sand canvas, a 600px cream card with the
 * masthead across its top, then the footer on the canvas. Raw `title`,
 * `eyebrow` and `preheader` strings are escaped here; `content` and `footer`
 * are already HTML. `logoUrl` is the day masthead; `logoDarkUrl`, when given,
 * is the night one that dark-mode clients swap in.
 */
export function shell(opts: {
  appUrl: string;
  logoUrl: string;
  logoDarkUrl?: string;
  title: string;
  eyebrow?: string;
  preheader: string;
  content: string;
  footer: string;
  subject: string;
}): string {
  const home = href(opts.appUrl, opts.appUrl);
  // Zero-width padding stops inbox previews running on into the body text.
  const spacer = '&#847;&zwnj;&nbsp;'.repeat(40);
  // The alt text doubles as the wordmark when images are off.
  const img = (src: string) =>
    `<img src="${esc(src)}" width="598" height="112" alt="TinyTown" style="display:block;width:100%;max-width:598px;height:auto;border:0;border-radius:15px 15px 0 0;font-family:${DISPLAY};font-size:26px;font-weight:800;letter-spacing:-0.03em;color:${C.ink};">`;
  const masthead = opts.logoDarkUrl
    ? `<a href="${home}" style="display:block;text-decoration:none;"><div class="day-only">${img(opts.logoUrl)}</div><!--[if !mso]><!--><div class="night-only" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${img(opts.logoDarkUrl)}</div><!--<![endif]--></a>`
    : `<a href="${home}" style="display:block;text-decoration:none;">${img(opts.logoUrl)}</a>`;
  const eyebrow = opts.eyebrow ? `<p class="link" style="margin:0 0 10px;${label(C.link, 12)}">${esc(opts.eyebrow)}</p>` : '';
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(opts.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>${RESPONSIVE}${DARK}
</style>
<style>${OUTLOOK_DARK}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};">${esc(opts.preheader)}${spacer}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${C.page};">
<tr><td align="center" class="outer" style="padding:36px 12px 44px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="background:${C.card};border:1px solid ${C.line};border-radius:16px;border-collapse:separate;box-shadow:0 1px 2px rgba(27,34,54,0.04),0 16px 40px -24px rgba(27,34,54,0.28);">
<tr><td style="padding:0;font-size:0;line-height:0;">${masthead}</td></tr>
<tr><td class="px" style="padding:30px 40px 36px;">
${eyebrow}<h1 class="ink h1" style="margin:0 0 18px;font-family:${DISPLAY};font-size:30px;line-height:1.15;font-weight:800;letter-spacing:-0.025em;color:${C.ink};">${esc(opts.title)}</h1>
${opts.content}
</td></tr>
</table>
</td></tr>
<tr><td class="px" style="padding:26px 40px 0;">
${opts.footer}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

const FOOT_STYLE = `margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.ink3};`;

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
  const host = hostOf(brand.appUrl);
  foot.push(
    `<p style="margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:1.6;"><span class="ink" style="font-family:${DISPLAY};font-size:14px;font-weight:800;letter-spacing:-0.02em;color:${C.ink};">TinyTown</span><span class="ink3" style="color:${C.ink3};"> &nbsp;&middot;&nbsp; A Tamagotchi for your startup &nbsp;&middot;&nbsp; </span><a class="link" href="${href(brand.appUrl, brand.appUrl)}" style="color:${C.link};text-decoration:none;">${esc(host)}</a></p>`,
  );
  if (contact) {
    foot.push(`<p class="ink3" style="${FOOT_STYLE}">${inlineHtml(contact, brand.appUrl)}</p>`);
    footText.push(inlineText(contact));
  }
  foot.push(`<p class="ink3" style="${FOOT_STYLE}">${esc(letter.reason)}</p>`);
  footText.push(letter.reason);
  if (letter.unsubscribe?.length) {
    foot.push(
      `<p class="ink3" style="${FOOT_STYLE}">${letter.unsubscribe
        .map((u) => `<a class="link" href="${href(u.url, brand.appUrl)}" style="color:${C.link};text-decoration:underline;text-underline-offset:2px;">${esc(u.label)}</a>`)
        .join(' &nbsp;&middot;&nbsp; ')}</p>`,
    );
    for (const u of letter.unsubscribe) footText.push(`${u.label}: ${u.url}`);
    if (brand.postalAddress) {
      foot.push(`<p class="ink3" style="${FOOT_STYLE}">${esc(brand.postalAddress)}</p>`);
      footText.push(brand.postalAddress);
    }
  }
  footText.push(`TinyTown · ${brand.appUrl}`);

  const html = shell({
    appUrl: brand.appUrl,
    logoUrl: `${brand.appUrl}/email/header@2x.png`,
    logoDarkUrl: `${brand.appUrl}/email/header-night@2x.png`,
    title: letter.title,
    ...(letter.eyebrow ? { eyebrow: oneLine(letter.eyebrow, 60) } : {}),
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

const PROVIDER_NAMES = { stripe: 'Stripe', github: 'GitHub', posthog: 'PostHog', ga4: 'Google Analytics' } as const;

export function welcome(brand: Brand, x: { interval: 'month' | 'year' }): Email {
  return render(brand, {
    subject: 'Welcome to TinyTown',
    preheader: 'Your plan is active. Connect Stripe and your city starts growing.',
    eyebrow: 'Welcome',
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
    eyebrow: 'Billing',
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
    eyebrow: 'Your plan',
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
    eyebrow: 'Your plan',
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
    ga4: 'This usually means TinyTown’s access was removed from your Google account.',
  }[x.provider];
  const what = {
    stripe: 'Until you reconnect, your city can’t see new revenue or customers.',
    github: 'Until you reconnect, new releases won’t show up in town.',
    posthog: 'Until you reconnect, your active-user count won’t update.',
    ga4: 'Until you reconnect, your active-user count won’t update.',
  }[x.provider];
  return render(brand, {
    subject: `Reconnect ${name} to keep your city growing`,
    preheader: `TinyTown lost its connection to ${name}.`,
    eyebrow: 'Connections',
    title: `Reconnect ${name}`,
    blocks: [p(`TinyTown lost its connection to ${name}. ${why}`), p(`${what} Nothing you built is lost.`), button(`Reconnect ${name}`, brand.appUrl), note('In TinyTown, open Account and choose Reconnect.')],
    reason: `You’re getting this because your TinyTown city is connected to ${name}.`,
  });
}

export function accountDeleted(brand: Brand): Email {
  return render(brand, {
    subject: 'Your TinyTown account is deleted',
    preheader: 'Your city, connections and saved metrics are gone, as you asked.',
    eyebrow: 'Your account',
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

/** The demo city in the evening sun, for invitations: what a grown city looks like. Its caption says whose it is. */
export function cityPicture(brand: Brand): Block {
  return {
    kind: 'image',
    src: `${brand.appUrl}/email/city@2x.jpg`,
    alt: 'A grown TinyTown in the evening sun: the Golden Gate, downtown towers and streets of homes around a little San Francisco Bay.',
    height: 259,
    caption: 'Nightjar, the demo city, after 540 days of a fictional startup. Yours grows from your own numbers.',
  };
}

export function accessInvited(brand: Brand, x: { email: string }): Email {
  return render(brand, {
    subject: 'Your spot in TinyTown is open',
    preheader: 'You joined the waitlist. Your city is ready to be built.',
    eyebrow: 'Your invite',
    title: 'Your spot is open',
    blocks: [
      p('You joined the TinyTown waitlist, and your spot is open now. Sign in with this address, ', { b: x.email }, ', and your city is waiting.'),
      cityPicture(brand),
      p('TinyTown turns your startup’s real numbers into a little San Francisco Bay. Every $1 of MRR is $10,000 to build with, every user needs a home, and your own house climbs from a hacker house to the moon.'),
      {
        kind: 'stub',
        items: [
          { label: 'Admit one', value: x.email },
          { label: 'Plan', value: '$29 a year' },
        ],
      },
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
    stats.push({ label: 'MRR', value: m(d.revenue.mrr), change: { text: signed(d.revenue.mrrChange, m), tone: tone(d.revenue.mrrChange) }, lead: true });
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
    if (d.city.unhoused > 0) blocks.push({ kind: 'callout', parts: [{ b: plural(d.city.unhoused, 'user') }, ` ${d.city.unhoused === 1 ? 'is' : 'are'} still looking for a home. Build housing before the city starts to fade.`] });
  }
  blocks.push(button('Open your city', brand.appUrl));

  return render(brand, {
    subject: `Your city this week: ${digestHeadline(d)}`,
    preheader: `${span}: what changed in ${d.name}.`,
    eyebrow: `Weekly digest · ${d.name}`,
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
      ? `<form method="post" action="${esc(opts.form.action)}" style="margin:24px 0 8px;"><input type="hidden" name="action" value="resubscribe"><button class="btn" type="submit" style="appearance:none;border:0;cursor:pointer;border-radius:12px;background:${C.button};padding:15px 26px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:650;color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,0.18),0 6px 14px -6px rgba(184,60,28,0.55);">${esc(opts.form.label)}</button></form>`
      : '',
    `<p class="ink3" style="margin:16px 0 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${C.ink3};"><a class="link" href="${href(opts.appUrl, '/')}" style="color:${C.link};">Back to TinyTown</a></p>`,
  ].join('\n');
  return shell({ appUrl: opts.appUrl, logoUrl: '/email/header@2x.png', logoDarkUrl: '/email/header-night@2x.png', title: opts.title, preheader: '', subject: `${opts.title} · TinyTown`, content, footer: '' });
}
