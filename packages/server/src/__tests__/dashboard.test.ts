import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { MemoryIdentityStore } from '../identity/index.js';
import { ShopService } from '../shop/shopService.js';

describe('dashboard presence expiry (§15) — service unit', () => {
  it('reports online only while the heartbeat is within the presence TTL', async () => {
    const store = new MemoryIdentityStore();
    await store.init();
    const presenceTtlSeconds = 60;
    const service = new ShopService(store, presenceTtlSeconds);

    // Seed an owner + shop directly, then claim the dashboard through the service.
    const userId = crypto.randomUUID();
    const now = Date.now();
    await store.createUser({
      id: userId,
      email: 'owner@shop.test',
      passwordHash: 'scrypt$not$a$real$hash$value',
      createdAt: now,
      updatedAt: now,
    });
    const shop = await service.createShop(userId, 'Presence Test');

    const claim = await service.claimDashboard(userId, shop.publicShopId, { takeOver: false });
    expect(claim.kind).toBe('ok');
    if (claim.kind !== 'ok') throw new Error('claim failed');

    // Fresh heartbeat → online.
    expect(await service.isShopOnline(shop.id)).toBe(true);

    // Simulate a heartbeat older than the TTL → offline, but the device row still exists.
    await store.touchDashboardDevice(claim.deviceSessionId, Date.now() - (presenceTtlSeconds + 1) * 1000);
    expect(await service.isShopOnline(shop.id)).toBe(false);

    const status = await service.getDashboardStatus(userId, shop.publicShopId, claim.deviceSessionId);
    expect(status.kind).toBe('ok');
    if (status.kind !== 'ok') throw new Error('status failed');
    expect(status.online).toBe(false); // stale
    expect(status.active).not.toBeNull(); // device still ACTIVE, just not fresh
    expect(status.active?.current).toBe(true); // caller's own device

    await store.close();
  });
});

describe('dashboard device routes (§11, §12, §21)', () => {
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

  async function registerAndGetCookie(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'password-1234' },
    });
    expect(res.statusCode).toBe(201);
    return res.cookies.find((c) => c.name === 'qd_auth')!.value;
  }

  async function createShop(cookie: string, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/shops',
      cookies: { qd_auth: cookie },
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; publicShopId: string };
  }

  function claim(cookie: string, publicShopId: string, body: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: body,
    });
  }

  function resolvePublic(publicShopId: string) {
    return app.inject({ method: 'GET', url: `/api/public/shops/${publicShopId}` });
  }

  it('rejects a claim when unauthenticated (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/shops/QD-ABCDEF/dashboard/claim', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('lets a member claim the dashboard and marks the shop online', async () => {
    const cookie = await registerAndGetCookie('owner-a@shop.test');
    const shop = await createShop(cookie, 'Corner Copy');

    // Before any claim, the public resolve reports offline.
    expect((await resolvePublic(shop.publicShopId)).json().online).toBe(false);

    const res = await claim(cookie, shop.publicShopId, { deviceLabel: 'Front Counter' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceSessionId).toEqual(expect.any(String));
    expect(body.shop.publicShopId).toBe(shop.publicShopId);

    // The shop is now online to a scanning customer (presence within TTL).
    expect((await resolvePublic(shop.publicShopId)).json().online).toBe(true);
  });

  it('returns 403 for an authenticated non-member and 404 for an unknown shop', async () => {
    const owner = await registerAndGetCookie('owner-a@shop.test');
    const stranger = await registerAndGetCookie('stranger@shop.test');
    const shop = await createShop(owner, 'Members Only');

    const forbidden = await claim(stranger, shop.publicShopId);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe('FORBIDDEN');

    const missing = await claim(owner, 'QD-ZZZZZZ');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('SHOP_NOT_FOUND');
  });

  it('rejects a malformed shop code with 400', async () => {
    const cookie = await registerAndGetCookie('owner-a@shop.test');
    const res = await claim(cookie, 'not-a-code');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SHOP_CODE');
  });

  it('enforces one active device: second claim conflicts (409) unless takeOver', async () => {
    const cookie = await registerAndGetCookie('owner-a@shop.test');
    const shop = await createShop(cookie, 'One Device');

    const first = await claim(cookie, shop.publicShopId, { deviceLabel: 'Laptop One' });
    expect(first.statusCode).toBe(200);
    const firstDeviceId = first.json().deviceSessionId;

    // Second laptop, same owner, no takeOver → 409 with the incumbent's details.
    const conflict = await claim(cookie, shop.publicShopId, { deviceLabel: 'Laptop Two' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('DASHBOARD_ALREADY_ACTIVE');
    expect(conflict.json().activeDevice.deviceLabel).toBe('Laptop One');

    // With takeOver → 200, new device session id, incumbent revoked.
    const takeover = await claim(cookie, shop.publicShopId, { deviceLabel: 'Laptop Two', takeOver: true });
    expect(takeover.statusCode).toBe(200);
    const secondDeviceId = takeover.json().deviceSessionId;
    expect(secondDeviceId).not.toBe(firstDeviceId);

    // The taken-over device's heartbeat now reports it lost the dashboard.
    const staleBeat = await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/heartbeat`,
      cookies: { qd_auth: cookie },
      payload: { deviceSessionId: firstDeviceId },
    });
    expect(staleBeat.statusCode).toBe(409);
    expect(staleBeat.json().error).toBe('DASHBOARD_REVOKED');

    // The current device heartbeats fine.
    const goodBeat = await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/heartbeat`,
      cookies: { qd_auth: cookie },
      payload: { deviceSessionId: secondDeviceId },
    });
    expect(goodBeat.statusCode).toBe(200);
    expect(goodBeat.json()).toEqual({ online: true, lastSeenAt: expect.any(Number) });
  });

  it('releases the dashboard, taking the shop offline', async () => {
    const cookie = await registerAndGetCookie('owner-a@shop.test');
    const shop = await createShop(cookie, 'Release Test');
    const deviceSessionId = (await claim(cookie, shop.publicShopId)).json().deviceSessionId;

    expect((await resolvePublic(shop.publicShopId)).json().online).toBe(true);

    const released = await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/release`,
      cookies: { qd_auth: cookie },
      payload: { deviceSessionId },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ released: true });

    // Offline again, and the released device can no longer heartbeat.
    expect((await resolvePublic(shop.publicShopId)).json().online).toBe(false);
    const beat = await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/heartbeat`,
      cookies: { qd_auth: cookie },
      payload: { deviceSessionId },
    });
    expect(beat.statusCode).toBe(409);
  });

  it('reports dashboard status with the caller’s current-device flag (§21)', async () => {
    const cookie = await registerAndGetCookie('owner-a@shop.test');
    const shop = await createShop(cookie, 'Status Test');

    // No device yet.
    const empty = await app.inject({
      method: 'GET',
      url: `/api/shops/${shop.publicShopId}/dashboard`,
      cookies: { qd_auth: cookie },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ active: null, online: false });

    const deviceSessionId = (await claim(cookie, shop.publicShopId, { deviceLabel: 'Kiosk' })).json().deviceSessionId;

    const status = await app.inject({
      method: 'GET',
      url: `/api/shops/${shop.publicShopId}/dashboard?deviceSessionId=${deviceSessionId}`,
      cookies: { qd_auth: cookie },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.online).toBe(true);
    expect(body.active.deviceLabel).toBe('Kiosk');
    expect(body.active.status).toBe('ACTIVE');
    expect(body.active.current).toBe(true);

    // Without the deviceSessionId query, `current` is false (can't attribute it).
    const anonView = await app.inject({
      method: 'GET',
      url: `/api/shops/${shop.publicShopId}/dashboard`,
      cookies: { qd_auth: cookie },
    });
    expect(anonView.json().active.current).toBe(false);
  });
});
