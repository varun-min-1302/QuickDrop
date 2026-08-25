/**
 * The one switch behind every `[QD][…]` / `[QuickDrop][…]` trace.
 *
 * This matters more than a logging flag normally would. The real-device bugs (concurrent
 * multi-customer failures) could not be reproduced on a laptop at all, so the ONLY way to
 * see them was a trace read off a phone's remote console while it ran the production
 * bundle over a tunnel. That makes the runtime opt-in a load-bearing debugging tool, and
 * the default-off behaviour a privacy and noise guarantee: three phones on one dashboard
 * emit tracing on every chunk.
 *
 * So both directions are pinned here — it must turn ON from a URL with no rebuild, and it
 * must stay OFF for an ordinary visitor.
 *
 * `detectDiagnosticsEnabled` takes the build mode as an argument precisely so this file can
 * exist: `import.meta.env.DEV` is a reserved Vite key that `vi.stubEnv` cannot override, so
 * a test has no other way to exercise the production-build branch — the one that ships.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectDiagnosticsEnabled } from '../lib/diagnostics.js';

const PROD = false;
const DEV = true;

/** Stand in for a browser without pulling in jsdom. */
function stubBrowser(opts: { search?: string; storage?: Record<string, string> } = {}) {
  const store = opts.storage ?? {};
  (globalThis as any).window = { location: { search: opts.search ?? '' } };
  (globalThis as any).localStorage = {
    getItem: (key: string) => (key in store ? store[key] : null),
  };
}

function clearBrowser() {
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
}

beforeEach(clearBrowser);
afterEach(clearBrowser);

describe('a development build traces by default', () => {
  it('is on with no URL flag and no browser at all', () => {
    expect(detectDiagnosticsEnabled(DEV)).toBe(true);
  });

  it('is on even when the runtime flags say nothing', () => {
    stubBrowser({ search: '?qdlog=0', storage: { quickdrop_debug: '0' } });
    expect(detectDiagnosticsEnabled(DEV)).toBe(true);
  });
});

describe('a production build is quiet unless explicitly asked', () => {
  it('is off for an ordinary visitor', () => {
    stubBrowser({ search: '' });
    expect(detectDiagnosticsEnabled(PROD)).toBe(false);
  });

  it('turns on from ?qdlog=1 — the real-device path, no rebuild needed', () => {
    stubBrowser({ search: '?qdlog=1' });
    expect(detectDiagnosticsEnabled(PROD)).toBe(true);
  });

  it('turns on from ?qdlog=1 alongside the parameters a real scan carries', () => {
    stubBrowser({ search: '?code=482913&qdlog=1' });
    expect(detectDiagnosticsEnabled(PROD)).toBe(true);
  });

  it('turns on from localStorage, so it survives navigating between pages', () => {
    stubBrowser({ storage: { quickdrop_debug: '1' } });
    expect(detectDiagnosticsEnabled(PROD)).toBe(true);
  });

  it.each([
    ['?qdlog=0', 'an explicit off'],
    ['?qdlog=', 'an empty value'],
    ['?qdlog=true', 'a value that is not exactly 1'],
    ['?qdlogs=1', 'a near-miss parameter name'],
    ['?code=482913', 'an ordinary scan URL'],
  ])('stays off for %s (%s)', (search) => {
    stubBrowser({ search });
    expect(detectDiagnosticsEnabled(PROD)).toBe(false);
  });

  it('stays off when storage holds some other value', () => {
    stubBrowser({ storage: { quickdrop_debug: 'yes' } });
    expect(detectDiagnosticsEnabled(PROD)).toBe(false);
  });
});

describe('detection never throws, whatever the environment', () => {
  it('survives having no window or localStorage at all', () => {
    clearBrowser();
    expect(detectDiagnosticsEnabled(PROD)).toBe(false);
  });

  it('survives localStorage being blocked by privacy settings', () => {
    (globalThis as any).window = { location: { search: '' } };
    (globalThis as any).localStorage = {
      getItem() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    };
    expect(detectDiagnosticsEnabled(PROD)).toBe(false);
  });

  it('still honours the URL flag when storage is blocked', () => {
    (globalThis as any).window = { location: { search: '?qdlog=1' } };
    (globalThis as any).localStorage = {
      getItem() {
        throw new Error('blocked');
      },
    };
    expect(detectDiagnosticsEnabled(PROD)).toBe(true);
  });
});

describe('the explicit setter overrides detection', () => {
  it('silences a dev build, which is how the test suite stays readable', async () => {
    const { isDiagnosticsEnabled, setDiagnosticsEnabled } = await import('../lib/diagnostics.js');

    setDiagnosticsEnabled(false);
    expect(isDiagnosticsEnabled()).toBe(false);

    setDiagnosticsEnabled(true);
    expect(isDiagnosticsEnabled()).toBe(true);
  });

  it('can be toggled repeatedly without drifting', async () => {
    const { isDiagnosticsEnabled, setDiagnosticsEnabled } = await import('../lib/diagnostics.js');
    for (const want of [false, true, false, false, true]) {
      setDiagnosticsEnabled(want);
      expect(isDiagnosticsEnabled()).toBe(want);
    }
  });
});

describe('the shop-side alias is the same switch, not a second flag', () => {
  it('setTransferQueueLogging and setDiagnosticsEnabled control one value', async () => {
    const { isDiagnosticsEnabled, setDiagnosticsEnabled } = await import('../lib/diagnostics.js');
    const { setTransferQueueLogging, isTransferQueueLoggingEnabled } = await import(
      '../lib/webrtc/ShopPeerManager.js'
    );

    // One flag, so tracing cannot be left half-enabled and leak into production.
    setTransferQueueLogging(false);
    expect(isDiagnosticsEnabled()).toBe(false);

    setDiagnosticsEnabled(true);
    expect(isTransferQueueLoggingEnabled()).toBe(true);

    setTransferQueueLogging(false);
  });
});
