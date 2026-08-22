import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError } from '../lib/api/http.js';
import {
  claimDashboard,
  heartbeatDashboard,
  releaseDashboard,
  getDashboardStatus,
  openShopSession,
} from '../lib/api/dashboard.js';

/**
 * Sub-phase 4 (ShopDashboardPage refactor) test gate — the dashboard-device + bridge API
 * client. Exercises the two outcomes modelled as return values (claim CONFLICT, heartbeat
 * REVOKED) plus the pass-through of other errors, all against a stubbed `fetch`. No React
 * rendering (Node test env), matching the existing client test convention.
 */

function fakeResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const PID = 'QD-7F82A9';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const SHOP = {
  id: '11111111-1111-1111-1111-111111111111',
  publicShopId: PID,
  name: 'Main Street Print',
  status: 'ACTIVE',
  role: 'OWNER',
  createdAt: 1,
  updatedAt: 1,
};

describe('claimDashboard', () => {
  it('POSTs to /dashboard/claim with credentials and returns ok on 200', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { deviceSessionId: DEVICE_ID, shop: SHOP }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await claimDashboard(PID);
    expect(out).toEqual({ kind: 'ok', deviceSessionId: DEVICE_ID, shop: SHOP });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/shops/${PID}/dashboard/claim`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ takeOver: false });
  });

  it('sends takeOver:true and an optional deviceLabel when provided', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { deviceSessionId: DEVICE_ID, shop: SHOP }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await claimDashboard(PID, { takeOver: true, deviceLabel: 'Front counter' });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({ takeOver: true, deviceLabel: 'Front counter' });
  });

  it('returns a conflict (with the active device) on 409 DASHBOARD_ALREADY_ACTIVE', async () => {
    const activeDevice = { deviceLabel: 'Chrome on Windows', connectedAt: 1000, lastSeenAt: 2000 };
    const spy = vi.fn().mockResolvedValue(
      fakeResponse(409, { error: 'DASHBOARD_ALREADY_ACTIVE', message: 'Another device…', activeDevice })
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await claimDashboard(PID);
    expect(out).toEqual({ kind: 'conflict', activeDevice });
  });

  it('re-throws other non-2xx (e.g. 403) as an ApiError instead of a conflict', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(403, { error: 'FORBIDDEN', message: 'No access.' }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const err = (await claimDashboard(PID).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });
});

describe('heartbeatDashboard', () => {
  it('returns ok with lastSeenAt on 200', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { online: true, lastSeenAt: 4242 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await heartbeatDashboard(PID, DEVICE_ID);
    expect(out).toEqual({ kind: 'ok', lastSeenAt: 4242 });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/shops/${PID}/dashboard/heartbeat`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ deviceSessionId: DEVICE_ID });
  });

  it('returns revoked on 409 DASHBOARD_REVOKED', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(409, { error: 'DASHBOARD_REVOKED', message: 'Taken over.' }));
    globalThis.fetch = spy as unknown as typeof fetch;

    expect(await heartbeatDashboard(PID, DEVICE_ID)).toEqual({ kind: 'revoked' });
  });

  it('re-throws other non-2xx (e.g. 404) as an ApiError', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(404, { error: 'SHOP_NOT_FOUND', message: 'Gone.' }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const err = (await heartbeatDashboard(PID, DEVICE_ID).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });
});

describe('releaseDashboard', () => {
  it('POSTs the deviceSessionId to /dashboard/release', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { released: true }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await releaseDashboard(PID, DEVICE_ID);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/shops/${PID}/dashboard/release`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ deviceSessionId: DEVICE_ID });
  });
});

describe('getDashboardStatus', () => {
  it('GETs /dashboard and appends the deviceSessionId query when given', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { active: null, online: false }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await getDashboardStatus(PID, DEVICE_ID);
    expect(out).toEqual({ active: null, online: false });
    expect(spy.mock.calls[0][0]).toBe(`/api/shops/${PID}/dashboard?deviceSessionId=${DEVICE_ID}`);
    expect(spy.mock.calls[0][1].method).toBe('GET');
  });

  it('omits the query string when no deviceSessionId is passed', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { active: null, online: false }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await getDashboardStatus(PID);
    expect(spy.mock.calls[0][0]).toBe(`/api/shops/${PID}/dashboard`);
  });
});

describe('openShopSession (bridge)', () => {
  const CREATED = {
    sessionId: '33333333-3333-3333-3333-333333333333',
    joinToken: 'a'.repeat(24),
    numericCode: '482913',
    expiresAt: '2026-08-22T12:00:00.000Z',
    status: 'CREATED',
    protocolVersion: '1.0',
  };

  it('POSTs to the shop-scoped /sessions endpoint with the requested ttl', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(201, CREATED));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await openShopSession(PID, 900);
    expect(out.joinToken).toBe('a'.repeat(24));

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/shops/${PID}/sessions`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ ttlSeconds: 900 });
  });

  it('sends an empty body when no ttl is provided (server applies its default)', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(201, CREATED));
    globalThis.fetch = spy as unknown as typeof fetch;

    await openShopSession(PID);
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({});
  });
});
