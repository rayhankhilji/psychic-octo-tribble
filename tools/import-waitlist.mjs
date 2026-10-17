#!/usr/bin/env node
/**
 * Imports the launch waitlist from a CSV export (Typeform, Tally, Mailchimp,
 * a spreadsheet) into the `waitlist` table (supabase/migrations/0004).
 *
 *   node --env-file=.env tools/import-waitlist.mjs waitlist.csv --dry-run
 *   node --env-file=.env tools/import-waitlist.mjs waitlist.csv --source=launch
 *
 * - The email column is found by its header (email, e-mail, email address…)
 *   or, failing that, as the column most full of addresses. `--column=Name`
 *   picks one by hand.
 * - A source column (source, utm_source, referrer, channel) is kept per row;
 *   otherwise every row gets `--source` (default `import`).
 * - A signup date column (created_at, signed up, joined, date, timestamp,
 *   submitted at) keeps people's real place in the queue. Without one, the
 *   file's order is the queue's order.
 * - Emails are trimmed and lowercased; duplicates keep their earliest row;
 *   anything that isn't a plausible address is reported, never sent.
 * - Rows already on the list are left exactly as they are (their place,
 *   source and invite), so running it twice is safe.
 *
 * Writes go through PostgREST with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY,
 * 500 rows at a time. `--dry-run` reads and checks the file and sends nothing.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The same check as server/access.ts normalizeEmail.
const EMAIL = /^[^\s@,()"'<>;:\\]+@[^\s@,()"'<>;:\\]+\.[^\s@,()"'<>;:\\]+$/;
const SOURCE = /^[\w .:@/-]{1,40}$/;

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().replace(/^mailto:/i, '').toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return EMAIL.test(email) ? email : null;
}

// ─── CSV ──────────────────────────────────────────────────────────────────

/** The delimiter the header line uses most: comma, semicolon (European Excel) or tab. */
function sniffDelimiter(text) {
  const line = text.slice(0, text.search(/\r?\n|$/));
  let best = ',';
  let most = -1;
  for (const d of [',', ';', '\t']) {
    const n = line.split(d).length;
    if (n > most) [best, most] = [d, n];
  }
  return best;
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes, CRLF, a leading BOM. */
export function parseCsv(input, delimiter = sniffDelimiter(input.replace(/^﻿/, ''))) {
  const text = input.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines (a trailing newline, spacer rows) aren't rows.
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const EMAIL_HEADER = /^(e-?mail|e-?mail[ _-]?address|your e-?mail|mail|work e-?mail)$/i;
const SOURCE_HEADER = /^(source|utm[ _-]?source|referr?er|channel|ref)$/i;
const DATE_HEADER = /^(created[ _-]?(at|on)?|signed[ _-]?up([ _-]at)?|sign[ _-]?up[ _-]date|joined([ _-]at)?|date|timestamp|submitted([ _-]at)?|subscribed([ _-]at)?|opt[ _-]?in[ _-]time)$/i;

/**
 * Which columns hold the email, the source and the signup date, and whether
 * the first row is a header. `column` (a header name or a 1-based number)
 * overrides the email column.
 */
export function detectColumns(rows, column) {
  const first = rows[0] ?? [];
  const header = !first.some((f) => normalizeEmail(f));
  const names = header ? first.map((f) => f.trim()) : [];
  const body = header ? rows.slice(1) : rows;
  let email = -1;
  if (column != null && column !== '') {
    const n = Number(column);
    email = Number.isInteger(n) && n >= 1 ? n - 1 : names.findIndex((h) => h.toLowerCase() === String(column).toLowerCase());
    if (email < 0) throw new Error(`No column called "${column}". The columns are: ${names.join(', ') || '(no header row)'}.`);
  } else {
    email = names.findIndex((h) => EMAIL_HEADER.test(h));
    if (email < 0) {
      // The column with the most addresses in it, from a sample.
      const sample = body.slice(0, 500);
      const width = Math.max(0, ...sample.map((r) => r.length));
      let most = 0;
      for (let c = 0; c < width; c++) {
        const hits = sample.filter((r) => normalizeEmail(r[c])).length;
        if (hits > most) [email, most] = [c, hits];
      }
    }
  }
  if (email < 0) throw new Error("Couldn't find a column of email addresses. Name one with --column.");
  return {
    header,
    names,
    email,
    source: names.findIndex((h) => SOURCE_HEADER.test(h)),
    date: names.findIndex((h) => DATE_HEADER.test(h)),
  };
}

function parseDate(raw) {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // Unix seconds or milliseconds.
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * The rows to send and what was set aside. Pure, for tests.
 * `now` anchors file order when there's no date column: row i joined at now - (n - i) ms.
 */
export function prepare(rows, { column, source = 'import', now = Date.now() } = {}) {
  if (!SOURCE.test(source)) throw new Error(`--source should be 1 to 40 letters, digits, spaces or . : @ / - _ (got "${source}").`);
  const cols = detectColumns(rows, column);
  const body = cols.header ? rows.slice(1) : rows;
  const firstLine = cols.header ? 2 : 1;
  const byEmail = new Map();
  const invalid = [];
  let duplicates = 0;
  let undated = 0;
  body.forEach((r, i) => {
    const raw = r[cols.email] ?? '';
    const email = normalizeEmail(raw);
    if (!email) {
      invalid.push({ line: firstLine + i, value: raw.trim().slice(0, 80) });
      return;
    }
    let at = cols.date >= 0 ? parseDate(r[cols.date]) : null;
    if (at == null) {
      if (cols.date >= 0) undated++;
      at = now - (body.length - i);
    }
    const src = cols.source >= 0 && SOURCE.test((r[cols.source] ?? '').trim()) ? r[cols.source].trim().toLowerCase() : source;
    const prev = byEmail.get(email);
    if (prev) {
      duplicates++;
      // Keep their earliest place in line.
      if (at < prev.at) byEmail.set(email, { ...prev, at });
      return;
    }
    byEmail.set(email, { email, source: src, at });
  });
  const entries = [...byEmail.values()].sort((a, b) => a.at - b.at || (a.email < b.email ? -1 : 1));
  return {
    columns: {
      email: cols.names[cols.email] ?? `column ${cols.email + 1}`,
      source: cols.source >= 0 ? cols.names[cols.source] : null,
      date: cols.date >= 0 ? cols.names[cols.date] : null,
    },
    read: body.length,
    entries: entries.map((e) => ({ email: e.email, source: e.source, created_at: new Date(e.at).toISOString() })),
    invalid,
    duplicates,
    undated,
  };
}

// ─── Upload ───────────────────────────────────────────────────────────────

const CHUNK = 500;

function headers(key) {
  const h = {
    apikey: key,
    'Content-Type': 'application/json',
    // Only rows new to the list come back, which is how we count them.
    Prefer: 'resolution=ignore-duplicates,return=representation',
  };
  // New-style secret keys aren't JWTs and go in apikey only (as in server/supabase.ts).
  if (!key.startsWith('sb_')) h.Authorization = `Bearer ${key}`;
  return h;
}

/** Sends the entries; returns how many were new to the list. Retries a chunk a few times on 429 or 5xx. */
export async function upload(entries, { url, key, fetchImpl = fetch, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let inserted = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(`${url}/rest/v1/waitlist?on_conflict=email&select=email`, { method: 'POST', headers: headers(key), body: JSON.stringify(chunk) });
      if (res.ok) {
        const rows = await res.json();
        inserted += Array.isArray(rows) ? rows.length : 0;
        break;
      }
      const retry = res.status === 429 || res.status >= 500;
      if (!retry || attempt >= 4) {
        // PostgREST errors can echo an address; the code and message are enough.
        let detail = '';
        try {
          const body = await res.json();
          detail = body?.code ? ` (${body.code}${body.message && !/@/.test(body.message) ? `: ${body.message}` : ''})` : '';
        } catch {
          // Not JSON.
        }
        throw new Error(`The database refused rows ${i + 1}–${i + chunk.length}: HTTP ${res.status}${detail}. ${inserted} rows were added before this; run again to continue (rows already added are skipped).`);
      }
      await sleep(500 * 2 ** (attempt - 1));
    }
    log(`  ${Math.min(i + CHUNK, entries.length).toLocaleString('en-US')} / ${entries.length.toLocaleString('en-US')} sent`);
  }
  return inserted;
}

// ─── Command line ─────────────────────────────────────────────────────────

function args(argv) {
  const out = { file: null, dryRun: false, source: 'import', column: null };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a.startsWith('--source=')) out.source = a.slice(9).trim();
    else if (a.startsWith('--column=')) out.column = a.slice(9).trim();
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.file = a;
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

const fmt = (n) => n.toLocaleString('en-US');

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts.help || !opts.file) {
    console.log('Usage: node --env-file=.env tools/import-waitlist.mjs <file.csv> [--dry-run] [--source=name] [--column=header]');
    process.exit(opts.help ? 0 : 1);
  }
  const p = prepare(parseCsv(readFileSync(opts.file, 'utf8')), { column: opts.column, source: opts.source });

  console.log(`Read ${fmt(p.read)} rows from ${opts.file}`);
  console.log(`  email column:  ${p.columns.email}`);
  console.log(`  source column: ${p.columns.source ?? `(none; every row gets "${opts.source}")`}`);
  console.log(`  date column:   ${p.columns.date ?? '(none; the file order is the queue order)'}`);
  console.log(`  ${fmt(p.entries.length)} unique addresses, ${fmt(p.duplicates)} duplicates merged, ${fmt(p.invalid.length)} invalid`);
  if (p.undated) console.log(`  ${fmt(p.undated)} rows had no readable date and keep their place in the file order`);
  for (const bad of p.invalid.slice(0, 10)) console.log(`    line ${bad.line}: ${bad.value ? JSON.stringify(bad.value) : '(empty)'}`);
  if (p.invalid.length > 10) console.log(`    …and ${fmt(p.invalid.length - 10)} more`);
  if (p.entries.length) {
    const first = p.entries[0];
    const last = p.entries.at(-1);
    console.log(`  queue runs from ${first.created_at.slice(0, 10)} to ${last.created_at.slice(0, 10)}`);
  }

  if (opts.dryRun) {
    console.log('\nDry run: nothing was sent.');
    return;
  }
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. node --env-file=.env …).');
  const u = new URL(url);
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('SUPABASE_URL must be https://');

  console.log(`\nSending to ${u.host}…`);
  const inserted = await upload(p.entries, { url, key, log: console.log });
  console.log(`\nDone. ${fmt(inserted)} added to the waitlist; ${fmt(p.entries.length - inserted)} were already on it and were left as they were.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
