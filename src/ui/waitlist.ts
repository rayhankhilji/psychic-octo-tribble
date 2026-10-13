/**
 * "You're on the list": signed in while the waitlist is on, before this
 * email's spot has opened. Warm, specific, and honest about what happens next.
 */
import { busy, focusFirst, makeDialog, skylineSvg } from './dialogs.ts';
import { escape, showModal } from './dom.ts';
import { ICON } from './icons.ts';

export class WaitlistDialog {
  private d: HTMLDialogElement;
  private signOut: () => Promise<void>;
  private support: string | null;

  constructor(opts: { signOut: () => Promise<void>; support: string | null }) {
    this.signOut = opts.signOut;
    this.support = opts.support;
    this.d = makeDialog('waitlist-dialog', 'waitlist-title');
    this.d.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act=signout]');
      if (!btn) return;
      busy(btn, 'Signing out…');
      void this.signOut();
    });
  }

  open(email: string | null) {
    this.d.innerHTML = `
      <div class="dialog-body auth-sent waitlist">
        <button class="btn ghost icon-only close auth-sent-close" type="button" data-act="close" aria-label="Close">${ICON.close}</button>
        <div class="waitlist-art" aria-hidden="true">${skylineSvg()}</div>
        <span class="waitlist-pill">${ICON.check}<span>Your spot is saved</span></span>
        <h2 id="waitlist-title">You're on the list</h2>
        <p class="sent-lede">TinyTown is opening to its waitlist a few founders at a time, so every new city gets a smooth start. We'll email ${email ? `<b>${escape(email)}</b>` : 'you'} the moment your spot opens. Then you can pick a plan and build yours.</p>
        <ul class="sent-tips">
          <li>${ICON.map}<span>Until then, the demo city is yours to explore: build, scrub through its story, and watch it at night.</span></li>
          <li>${ICON.mail}<span>Joined with a different email? Sign out and sign in with that one.</span></li>
          ${this.support ? `<li>${ICON.help}<span>Questions? Write to <a href="mailto:${escape(this.support)}">${escape(this.support)}</a>.</span></li>` : ''}
        </ul>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" data-act="signout">${ICON.signOut}<span class="label">Sign out</span></button>
          <button class="btn primary" type="button" data-act="close" data-autofocus>Explore the demo</button>
        </div>
      </div>`;
    showModal(this.d);
    focusFirst(this.d);
  }
}
