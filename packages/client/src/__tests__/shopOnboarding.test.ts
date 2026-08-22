import { describe, it, expect, afterEach, vi } from 'vitest';
import { validateEmail, validatePassword, validateLoginPassword, validateShopName } from '../lib/validation.js';
import { createShop, listShops, getShop, renameShop } from '../lib/api/shops.js';

/**
 * Sub-phase 2 (onboarding / shop-setup) test gate. Pure validators (which reuse the shared
 * server schemas) plus the shop API calls exercised against a stubbed `fetch`.
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

const SUMMARY = {
  id: '11111111-1111-1111-1111-111111111111',
  publicShopId: 'QD-7F82A9',
  name: 'Main Street Print',
  status: 'ACTIVE',
  role: 'OWNER',
  createdAt: 1,
  updatedAt: 1,
};

describe('form validation (reuses shared schemas)', () => {
  it('validateEmail accepts valid addresses and rejects malformed ones', () => {
    expect(validateEmail('owner@shop.co')).toBeNull();
    expect(validateEmail('not-an-email')).toBeTruthy();
    expect(validateEmail('')).toBeTruthy();
  });

  it('validatePassword enforces the 8-char registration minimum', () => {
    expect(validatePassword('12345678')).toBeNull();
    expect(validatePassword('short')).toBeTruthy();
  });

  it('validateLoginPassword only requires non-empty (server uses min 1)', () => {
    expect(validateLoginPassword('x')).toBeNull();
    expect(validateLoginPassword('')).toBe('Password is required.');
  });

  it('validateShopName requires 1–80 chars after trimming', () => {
    expect(validateShopName('Main Street Print')).toBeNull();
    expect(validateShopName('   ')).toBeTruthy();
    expect(validateShopName('a'.repeat(81))).toBeTruthy();
  });
});

describe('shop API calls (via a stubbed fetch)', () => {
  it('createShop POSTs the name to /api/shops with credentials and returns the summary', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(201, SUMMARY));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await createShop('Main Street Print');
    expect(out.publicShopId).toBe('QD-7F82A9');

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/shops');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ name: 'Main Street Print' });
  });

  it('listShops GETs /api/shops and unwraps the { shops } envelope to an array', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { shops: [SUMMARY] }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const shops = await listShops();
    expect(Array.isArray(shops)).toBe(true);
    expect(shops).toHaveLength(1);
    expect(shops[0].publicShopId).toBe('QD-7F82A9');
    expect(spy.mock.calls[0][0]).toBe('/api/shops');
    expect(spy.mock.calls[0][1].method).toBe('GET');
  });

  it('getShop reads /api/shops/:id', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, SUMMARY));
    globalThis.fetch = spy as unknown as typeof fetch;

    await getShop(SUMMARY.id);
    expect(spy.mock.calls[0][0]).toBe(`/api/shops/${SUMMARY.id}`);
    expect(spy.mock.calls[0][1].method).toBe('GET');
  });

  it('renameShop PATCHes the new name to /api/shops/:id', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { ...SUMMARY, name: 'Renamed' }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await renameShop(SUMMARY.id, 'Renamed');
    expect(out.name).toBe('Renamed');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`/api/shops/${SUMMARY.id}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed' });
  });
});
