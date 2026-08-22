import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  TRANSFER_SESSION_TTL_SECONDS,
  isSessionExpired,
  formatRelativeTime,
  describeActiveDevice,
} from '../lib/dashboard/dashboardPolicy.js';

/**
 * Sub-phase 4 test gate — pure dashboard-lifecycle policy helpers (timing + take-over
 * prompt formatting). No DOM/React; `now` is always injected so results are deterministic.
 */

describe('dashboard timing constants', () => {
  it('heartbeats comfortably within the transfer-session TTL', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    // The presence beat must be far shorter than the session lifetime it helps keep alive.
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(TRANSFER_SESSION_TTL_SECONDS * 1000);
    expect(TRANSFER_SESSION_TTL_SECONDS).toBe(900);
  });
});

describe('isSessionExpired', () => {
  const now = 1_000_000;

  it('is true at/after expiry and false before it (ISO string)', () => {
    expect(isSessionExpired(new Date(now - 1).toISOString(), now)).toBe(true);
    expect(isSessionExpired(new Date(now).toISOString(), now)).toBe(true);
    expect(isSessionExpired(new Date(now + 60_000).toISOString(), now)).toBe(false);
  });

  it('accepts epoch-ms expiry too', () => {
    expect(isSessionExpired(now - 1, now)).toBe(true);
    expect(isSessionExpired(now + 1, now)).toBe(false);
  });

  it('treats an unparseable expiry as expired (fail safe → renew)', () => {
    expect(isSessionExpired('not-a-date', now)).toBe(true);
  });
});

describe('formatRelativeTime', () => {
  const now = 10_000_000;
  it('phrases sub-minute, minute, hour, and day spans', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 90_000, now)).toBe('1 min ago');
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2 hr ago');
    expect(formatRelativeTime(now - 25 * 3_600_000, now)).toBe('1 day ago');
    expect(formatRelativeTime(now - 72 * 3_600_000, now)).toBe('3 days ago');
  });

  it('never returns a negative span for a future timestamp', () => {
    expect(formatRelativeTime(now + 5_000, now)).toBe('just now');
  });
});

describe('describeActiveDevice', () => {
  it('combines the device label with a relative last-seen phrase', () => {
    const now = 5_000_000;
    const out = describeActiveDevice({ deviceLabel: 'Chrome on Windows', lastSeenAt: now - 120_000 }, now);
    expect(out).toContain('Chrome on Windows');
    expect(out).toContain('last active');
    expect(out).toContain('2 min ago');
  });
});
