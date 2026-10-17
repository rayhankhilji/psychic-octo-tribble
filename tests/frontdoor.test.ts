import { describe, expect, it } from 'vitest';
import { frontDoorInset, wantsFrontDoor, type FrontDoorFacts } from '../src/ui/frontdoor.ts';

const first: FrontDoorFacts = { search: '', seen: false, demo: true, signedIn: false };

describe('wantsFrontDoor', () => {
  it('shows on a first visit to the demo, signed out', () => {
    expect(wantsFrontDoor(first)).toBe(true);
    expect(wantsFrontDoor({ ...first, dialog: 'none' })).toBe(true);
  });

  it('shows once per browser', () => {
    expect(wantsFrontDoor({ ...first, seen: true })).toBe(false);
  });

  it('never over live data, a signed-in founder, or a dialog that opens by itself', () => {
    expect(wantsFrontDoor({ ...first, demo: false })).toBe(false);
    expect(wantsFrontDoor({ ...first, signedIn: true })).toBe(false);
    expect(wantsFrontDoor({ ...first, dialog: 'signin' })).toBe(false);
    expect(wantsFrontDoor({ ...first, dialog: 'plan' })).toBe(false);
    expect(wantsFrontDoor({ ...first, dialog: 'waitlist' })).toBe(false);
  });

  it('stays out of the way of links with a purpose', () => {
    for (const k of ['demo', 'debug', 'fresh', 'time=13:00', 'view=-11.5,-9.2,0.46', 'away=3', 'replay', 'seed=4', 'mockapi=signedout', 'quality=low']) {
      expect(wantsFrontDoor({ ...first, search: `?${k}` }), k).toBe(false);
    }
    // Unrelated parameters (a campaign tag) don't count.
    expect(wantsFrontDoor({ ...first, search: '?utm_source=waitlist' })).toBe(true);
  });

  it('?intro forces it, whatever else is going on', () => {
    expect(wantsFrontDoor({ search: '?intro&mockapi=signedout&debug&time=22:00', seen: true, demo: true, signedIn: false })).toBe(true);
    expect(wantsFrontDoor({ search: new URLSearchParams('intro'), seen: true, demo: false, signedIn: true, dialog: 'plan' })).toBe(true);
  });
});

describe('frontDoorInset', () => {
  it('keeps the city clear of the left column on wide screens', () => {
    const { left, bottom } = frontDoorInset(1440, 900);
    expect(bottom).toBe(0);
    expect(left * 1440).toBeCloseTo(576);
    expect(frontDoorInset(1000, 800).left * 1000).toBe(460);
    expect(frontDoorInset(2560, 1440).left * 2560).toBe(620);
  });

  it('puts the city in the top half on phones and portrait screens', () => {
    expect(frontDoorInset(390, 844)).toEqual({ left: 0, bottom: 0.56 });
    expect(frontDoorInset(1024, 1366).left).toBe(0);
    expect(frontDoorInset(375, 667).bottom).toBe(0.62);
  });
});
