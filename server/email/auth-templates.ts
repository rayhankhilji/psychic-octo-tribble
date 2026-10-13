import { render, type Block, type Brand } from './templates.ts';

/**
 * Supabase Auth's own emails (magic link, confirm sign-up, change email,
 * invite, reauthentication, password recovery) in the TinyTown look. Supabase
 * sends these itself, filling in Go template variables, so the HTML here is
 * rendered once with placeholders and saved to supabase/templates/*.html,
 * where the owner pastes it into the dashboard (see the README there).
 *
 * `tests/server-email-templates.test.ts` fails if the saved files drift from
 * this source; run it with UPDATE_EMAIL_TEMPLATES=1 to rewrite them.
 */

// Stand-ins that survive rendering (URL checks, escaping), swapped for Supabase's variables afterwards.
const SITE = 'https://site.invalid';
const CONFIRM = 'https://confirm.invalid/';

export interface AuthTemplate {
  /** File in supabase/templates/. */
  file: string;
  /** The dashboard's name for it. */
  name: string;
  /** Paste into the template's Subject field. */
  subject: string;
  html: string;
}

const brand: Brand = { appUrl: SITE, replies: false, supportEmail: null, postalAddress: null };

const fallback: Block = { kind: 'note', parts: ['Button not working? Copy this link into your browser: ', { a: CONFIRM, href: CONFIRM }] };

function build(file: string, name: string, subject: string, title: string, preheader: string, blocks: Block[], reason: string): AuthTemplate {
  const html = render(brand, { subject, preheader, title, blocks, reason }).html
    .replaceAll(CONFIRM, '{{ .ConfirmationURL }}')
    .replaceAll(`${SITE}/`, '{{ .SiteURL }}/')
    .replaceAll(SITE, '{{ .SiteURL }}')
    .replaceAll('site.invalid', '{{ .SiteURL }}');
  return { file, name, subject, html };
}

const IGNORE = 'If you didn’t ask for this, you can ignore this email. Nothing happens without the link.';

export function authTemplates(): AuthTemplate[] {
  return [
    build(
      'magic_link.html',
      'Magic link',
      'Your TinyTown sign-in link',
      'Sign in to TinyTown',
      'Your sign-in link. It works once and expires in an hour.',
      [
        { kind: 'p', parts: ['Use the button below to sign in as ', { b: '{{ .Email }}' }, '.'] },
        { kind: 'button', label: 'Sign in to TinyTown', url: CONFIRM },
        { kind: 'note', parts: ['The link works once and expires in an hour. ', IGNORE] },
        fallback,
      ],
      'You’re getting this because someone asked to sign in to TinyTown with this address.',
    ),
    build(
      'confirmation.html',
      'Confirm signup',
      'Confirm your email for TinyTown',
      'Confirm your email',
      'Confirm your email and you’re in.',
      [
        { kind: 'p', parts: ['Welcome to TinyTown. Use the button below to confirm ', { b: '{{ .Email }}' }, ' and sign in.'] },
        { kind: 'button', label: 'Confirm and sign in', url: CONFIRM },
        { kind: 'note', parts: ['The link works once and expires in an hour. ', IGNORE] },
        fallback,
      ],
      'You’re getting this because someone signed up for TinyTown with this address.',
    ),
    build(
      'email_change.html',
      'Change email address',
      'Confirm your new TinyTown email',
      'Confirm your new email',
      'Confirm the change to your TinyTown sign-in address.',
      [
        { kind: 'p', parts: ['You asked to change the email on your TinyTown account from ', { b: '{{ .Email }}' }, ' to ', { b: '{{ .NewEmail }}' }, '.'] },
        { kind: 'p', parts: ['Use the button below to confirm the change.'] },
        { kind: 'button', label: 'Confirm the change', url: CONFIRM },
        { kind: 'note', parts: ['Didn’t ask for this? Ignore this email and your address stays as it is.'] },
        fallback,
      ],
      'You’re getting this because someone asked to change the email on a TinyTown account.',
    ),
    build(
      'invite.html',
      'Invite user',
      'You’re invited to TinyTown',
      'You’re invited',
      'Your startup’s real numbers, built into a little San Francisco Bay.',
      [
        { kind: 'p', parts: ['You’ve been invited to TinyTown, where your startup’s real numbers build a little San Francisco Bay. Every $1 of MRR is $10,000 to build with, and your own house climbs from a hacker house to the moon.'] },
        { kind: 'button', label: 'Accept the invite', url: CONFIRM },
        { kind: 'note', parts: ['The link works once. ', IGNORE] },
        fallback,
      ],
      'You’re getting this because someone invited this address to TinyTown.',
    ),
    build(
      'reauthentication.html',
      'Reauthentication',
      'Your TinyTown verification code',
      'Confirm it’s you',
      'Your verification code for TinyTown.',
      [
        { kind: 'p', parts: ['Enter this code in TinyTown to confirm it’s you.'] },
        { kind: 'code', label: 'Your code', code: '{{ .Token }}' },
        { kind: 'note', parts: ['The code expires soon. If you didn’t ask for it, you can ignore this email.'] },
      ],
      'You’re getting this because someone asked to confirm a change on your TinyTown account.',
    ),
    build(
      'recovery.html',
      'Reset password',
      'Sign in to TinyTown',
      'Sign in to TinyTown',
      'TinyTown has no passwords: this link signs you in.',
      [
        { kind: 'p', parts: ['Someone asked to reset the password for ', { b: '{{ .Email }}' }, '. TinyTown signs you in with email links, so there’s no password to reset: the button simply signs you in.'] },
        { kind: 'button', label: 'Sign in to TinyTown', url: CONFIRM },
        { kind: 'note', parts: ['The link works once and expires in an hour. ', IGNORE] },
        fallback,
      ],
      'You’re getting this because someone asked to reset the password for this address.',
    ),
  ];
}
