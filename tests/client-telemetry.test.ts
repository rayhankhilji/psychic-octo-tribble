import { describe, expect, it } from 'vitest';
import { scrub } from '../src/telemetry.ts';

describe('telemetry scrub', () => {
  it('removes emails, tokens and keys', () => {
    expect(scrub('Failed for mara@nightjar.dev at /?access_token=abc.def&x=1')).toBe('Failed for [email] at /?access_token=[redacted]&x=1');
    expect(scrub('bad key phx_12345abc and rk_live_9xYz')).toBe('bad key [key] and [key]');
    expect(scrub('TypeError: x is undefined')).toBe('TypeError: x is undefined');
  });
});
