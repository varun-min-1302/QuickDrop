import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { MemoryIdentityStore } from '../identity/index.js';
import {
  PUBLIC_SHOP_ID_REGEX,
  PUBLIC_SHOP_ID_PREFIX,
} from '@quickdrop/shared';
import {
  generateCandidatePublicShopId,
  generatePublicShopId,
} from '../shop/publicShopId.js';

describe('publicShopId generation (§3)', () => {
  it('produces ids matching the QD- unambiguous-alphabet format', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateCandidatePublicShopId();
      expect(id).toMatch(PUBLIC_SHOP_ID_REGEX);
      expect(id.startsWith(PUBLIC_SHOP_ID_PREFIX)).toBe(true);
      // No ambiguous characters (0/O/1/I) in the body.
      expect(id.slice(3)).not.toMatch(/[01OI]/);
    }
  });

  it('retries until it finds a free id', async () => {
    let calls = 0;
    const isTaken = async () => {
      calls++;
      return calls < 3; // first two candidates "taken", third is free
    };
    const id = await generatePublicShopId(isTaken);
    expect(id).toMatch(PUBLIC_SHOP_ID_REGEX);
    expect(calls).toBe(3);
  });

  it('throws if it cannot find a free id within the attempt cap', async () => {
    await expect(generatePublicShopId(async () => true)).rejects.toThrow(/unique publicShopId/);
  });
});

describe('shop identity routes (§5, §6, §9)', () => {
  let app: FastifyInstance;
  let identityStore: MemoryIdentityStore;

  beforeEach(async () => {
    identityStore = new MemoryIdentityStore();
    const built = await buildApp(undefined, identityStore);
    app = built.fastify;
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  /** Register a fresh owner and return their auth cookie value. */
  async function registerAndGetCookie(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'password-1234' },
    });
    expect(res.statusCode).toBe(201);
    return res.cookies.find((c) => c.name === 'qd_auth')!.value;
  }

  function createShop(cookie: string, name: string) {
    return app.inject({
      method: 'POST',
      url: '/api/shops',
      cookies: { qd_auth: cookie },
      payload: { name },
    });
  }

  it('rejects shop creation when unauthenticated (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/shops', payload: { name: 'Nope' } });
    expect(res.statusCode).toBe(401);
  });

  it('creates a permanent shop with a valid publicShopId and OWNER role', async () => {
    const cookie = await registerAndGetCookie('owner-a@shop.test');
    const res = await createShop(cookie, 'Campus Print Hub');
    expect(res.statusCode).toBe(201);

    const shop = res.json();
    expect(shop.publicShopId).toMatch(PUBLIC_SHOP_ID_REGEX);
    expect(shop.name).toBe('Campus Print Hub');
    expect(shop.role).toBe('OWNER');
    expect(shop.status).toBe('ACTIVE');
    expect(shop.id).toEqual(expect.any(String));

    // Persisted membership links the authenticated user as OWNER.
    const membership = await identityStore.getMembership(shop.id, (await identityStore.getUserByEmail('owner-a@shop.test'))!.id);
    expect(membership?.role).toBe('OWNER');
  });

  it('lists only the caller’s own shops', async () => {
    const cookieA = await registerAndGetCookie('owner-a@shop.test');
    const cookieB = await registerAndGetCookie('owner-b@shop.test');
    await createShop(cookieA, 'A Shop');
    await createShop(cookieA, 'A Shop Two');
    await createShop(cookieB, 'B Shop');

    const listA = await app.inject({ method: 'GET', url: '/api/shops', cookies: { qd_auth: cookieA } });
    expect(listA.statusCode).toBe(200);
    const namesA = listA.json().shops.map((s: { name: string }) => s.name).sort();
    expect(namesA).toEqual(['A Shop', 'A Shop Two']);

    const listB = await app.inject({ method: 'GET', url: '/api/shops', cookies: { qd_auth: cookieB } });
    expect(listB.json().shops).toHaveLength(1);
  });

  it('generates distinct publicShopIds for distinct shops', async () => {
    const cookie = await registerAndGetCookie('owner-a@shop.test');
    const one = (await createShop(cookie, 'One')).json();
    const two = (await createShop(cookie, 'Two')).json();
    expect(one.publicShopId).not.toEqual(two.publicShopId);
  });

  it('enforces the 401/403/404 ladder on GET /shops/:id', async () => {
    const cookieA = await registerAndGetCookie('owner-a@shop.test');
    const cookieB = await registerAndGetCookie('owner-b@shop.test');
    const shop = (await createShop(cookieA, 'A Shop')).json();

    // Owner: 200
    const owner = await app.inject({ method: 'GET', url: `/api/shops/${shop.id}`, cookies: { qd_auth: cookieA } });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().publicShopId).toBe(shop.publicShopId);

    // Authenticated non-member: 403 (not 404 — the shop exists, they just can't see it)
    const forbidden = await app.inject({ method: 'GET', url: `/api/shops/${shop.id}`, cookies: { qd_auth: cookieB } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe('FORBIDDEN');

    // Unauthenticated: 401
    const anon = await app.inject({ method: 'GET', url: `/api/shops/${shop.id}` });
    expect(anon.statusCode).toBe(401);

    // Nonexistent shop: 404
    const missing = await app.inject({
      method: 'GET',
      url: '/api/shops/00000000-0000-4000-8000-000000000000',
      cookies: { qd_auth: cookieA },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('SHOP_NOT_FOUND');
  });

  it('renames a shop for the owner and forbids a non-member', async () => {
    const cookieA = await registerAndGetCookie('owner-a@shop.test');
    const cookieB = await registerAndGetCookie('owner-b@shop.test');
    const shop = (await createShop(cookieA, 'Old Name')).json();

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/shops/${shop.id}`,
      cookies: { qd_auth: cookieA },
      payload: { name: 'New Name' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('New Name');
    expect(renamed.json().publicShopId).toBe(shop.publicShopId); // identity is permanent

    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/shops/${shop.id}`,
      cookies: { qd_auth: cookieB },
      payload: { name: 'Hijack' },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  describe('public resolve (§4, §14) — customer-facing, unauthenticated', () => {
    it('resolves a known shop to its minimal public view (offline until a dashboard connects)', async () => {
      const cookie = await registerAndGetCookie('owner-a@shop.test');
      const shop = (await createShop(cookie, 'Corner Copy')).json();

      // No cookie — this is the walk-in customer path.
      const res = await app.inject({ method: 'GET', url: `/api/public/shops/${shop.publicShopId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        publicShopId: shop.publicShopId,
        name: 'Corner Copy',
        online: false, // no dashboard device has claimed presence yet (Phase G)
      });
      // The minimal view must not leak owner identity or internal ids.
      expect(res.payload).not.toContain('owner-a@shop.test');
      expect(res.payload.toLowerCase()).not.toContain('createdby');
    });

    it('returns 404 for an unknown but well-formed shop code', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/public/shops/QD-ZZZZZZ' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('SHOP_NOT_FOUND');
    });

    it('returns 400 for a malformed shop code', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/public/shops/not-a-code' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INVALID_SHOP_CODE');
    });

    it('normalizes lowercase codes (QR robustness)', async () => {
      const cookie = await registerAndGetCookie('owner-a@shop.test');
      const shop = (await createShop(cookie, 'Case Test')).json();
      const res = await app.inject({
        method: 'GET',
        url: `/api/public/shops/${shop.publicShopId.toLowerCase()}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicShopId).toBe(shop.publicShopId);
    });
  });
});
