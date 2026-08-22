import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError } from '../lib/api/http.js';
import { resolvePublicShop, connectPublicShop } from '../lib/api/publicShop.js';

/**
 * Sub-phase 5 (customer permanent-QR flow) test gate — the PUBLIC shop API client.
 * Exercises resolve + connect against a stubbed `fetch`, including the two documented 409
 * states modelled as return values (SHOP_OFFLINE, SHOP_NOT_READY) and the pass-through of
 * genuinely exceptional responses. No React rendering (Node test env), matching the
 * existing client test convention.
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

describe('resolvePublicShop', () => {
  it('GETs /api/public/shops/:pid with credentials and returns the resolved shop', async () => {
    const shop = { publicShopId: PID, name: 'Main Street Print', online: true };
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, shop));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await resolvePublicShop(PID);
    expect(out).toEqual(shop);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/public/shops/${PID}`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
  });

  it('throws an ApiError on 404 SHOP_NOT_FOUND', async () => {
    const spy = vi.fn().mockResolvedValue(
      fakeResponse(404, { error: 'SHOP_NOT_FOUND', message: 'That shop code was not found.' })
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const err = (await resolvePublicShop(PID).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('SHOP_NOT_FOUND');
  });
});

describe('connectPublicShop', () => {
  const SESSION = {
    publicShopId: PID,
    name: 'Main Street Print',
    sessionId: '33333333-3333-3333-3333-333333333333',
    numericCode: '482913',
    expiresAt: 1_900_000_000_000,
  };

  it('POSTs to /connect with credentials and returns ok with the bridged session', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, SESSION));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await connectPublicShop(PID);
    expect(out).toEqual({ kind: 'ok', session: SESSION });

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/public/shops/${PID}/connect`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('returns offline on 409 SHOP_OFFLINE', async () => {
    const spy = vi.fn().mockResolvedValue(
      fakeResponse(409, { error: 'SHOP_OFFLINE', message: 'This shop is not open right now.' })
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    expect(await connectPublicShop(PID)).toEqual({ kind: 'offline' });
  });

  it('returns not_ready on 409 SHOP_NOT_READY', async () => {
    const spy = vi.fn().mockResolvedValue(
      fakeResponse(409, { error: 'SHOP_NOT_READY', message: 'The shop has not started a transfer session yet.' })
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    expect(await connectPublicShop(PID)).toEqual({ kind: 'not_ready' });
  });

  it('re-throws a 404 (stale/unknown shop) as an ApiError instead of a soft state', async () => {
    const spy = vi.fn().mockResolvedValue(
      fakeResponse(404, { error: 'SHOP_NOT_FOUND', message: 'That shop code was not found.' })
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const err = (await connectPublicShop(PID).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });

  it('re-throws an unrelated 409 code as an ApiError (only the two known states are soft)', async () => {
    const spy = vi.fn().mockResolvedValue(
      fakeResponse(409, { error: 'SOME_OTHER_CONFLICT', message: 'Nope.' })
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const err = (await connectPublicShop(PID).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('SOME_OTHER_CONFLICT');
  });
});
