import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { MemoryIdentityStore } from '../identity/index.js';

/**
 * Phase F — permanent-QR → transfer-session bridge (spec §16).
 *
 * Verifies the two bridge endpoints and the additive signaling relaxation that lets a
 * bridge customer JOIN with only the session's numericCode (no raw joinToken). None of
 * the existing token/numericCode/sessionId join paths change; this suite is purely
 * additive coverage.
 */
describe('Phase F bridge — shop-scoped session create + public connect (§16)', () => {
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

  function claimDashboard(cookie: string, publicShopId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: { deviceLabel: 'Test Counter' },
    });
  }

  function openSession(cookie: string, publicShopId: string, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/sessions`,
      cookies: { qd_auth: cookie },
      payload,
    });
  }

  function connect(publicShopId: string) {
    return app.inject({ method: 'POST', url: `/api/public/shops/${publicShopId}/connect` });
  }

  // ── Authenticated shop-scoped session open ────────────────────────────────

  it('rejects a shop-scoped session open when unauthenticated (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/shops/QD-ABCDEF/sessions', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed shop code with 400 INVALID_SHOP_CODE', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const res = await openSession(cookie, 'not-a-code');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SHOP_CODE');
  });

  it('returns 404 for an unknown shop and 403 for a non-member', async () => {
    const owner = await registerAndGetCookie('owner@shop.test');
    const stranger = await registerAndGetCookie('stranger@shop.test');
    const shop = await createShop(owner, 'Members Only');

    const unknown = await openSession(owner, 'QD-ZZZZZZ');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('SHOP_NOT_FOUND');

    const forbidden = await openSession(stranger, shop.publicShopId);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe('FORBIDDEN');
  });

  it('mints a shop-scoped transfer session with the full creator payload', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Corner Copy');

    const res = await openSession(cookie, shop.publicShopId, { ttlSeconds: 900 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body.joinToken).toEqual(expect.any(String)); // raw token returned only to the shop
    expect(body.numericCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.status).toBe('CREATED');
    expect(typeof body.expiresAt).toBe('string'); // ISO
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
    expect(body.protocolVersion).toEqual(expect.any(String));
    // The internal shopId must NOT leak to the creator payload.
    expect(body.shopId).toBeUndefined();
  });

  // ── Public customer connect ───────────────────────────────────────────────

  it('rejects a malformed shop code on connect with 400', async () => {
    const res = await connect('nope');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SHOP_CODE');
  });

  it('returns 404 SHOP_NOT_FOUND for an unknown shop on connect', async () => {
    const res = await connect('QD-ZZZZZZ');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('SHOP_NOT_FOUND');
  });

  it('refuses to connect when the shop is offline (409 SHOP_OFFLINE)', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Closed Shop');
    // No dashboard claimed → offline, even if a session somehow existed.
    const res = await connect(shop.publicShopId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SHOP_OFFLINE');
  });

  it('refuses to connect when online but no session has been opened (409 SHOP_NOT_READY)', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Open But Idle');
    expect((await claimDashboard(cookie, shop.publicShopId)).statusCode).toBe(200);

    const res = await connect(shop.publicShopId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SHOP_NOT_READY');
  });

  it('bridges a customer to the shop’s current session, handing back its numericCode', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Ready Shop');
    await claimDashboard(cookie, shop.publicShopId);
    const opened = (await openSession(cookie, shop.publicShopId)).json();

    const res = await connect(shop.publicShopId);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.publicShopId).toBe(shop.publicShopId);
    expect(body.name).toBe('Ready Shop');
    expect(body.sessionId).toBe(opened.sessionId);
    expect(body.numericCode).toBe(opened.numericCode);
    expect(typeof body.expiresAt).toBe('number');
    // The bridge must NEVER hand a raw joinToken to an unauthenticated customer.
    expect(body.joinToken).toBeUndefined();
  });

  it('clears the pointer and reports not-ready after the session is ended (§16 additive)', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Ephemeral');
    await claimDashboard(cookie, shop.publicShopId);
    const opened = (await openSession(cookie, shop.publicShopId)).json();

    // Customer can connect while the session is live.
    expect((await connect(shop.publicShopId)).statusCode).toBe(200);

    // Shop ends the session; the shop→session pointer must not outlive it.
    const del = await app.inject({ method: 'DELETE', url: `/api/sessions/${opened.sessionId}` });
    expect(del.statusCode).toBe(200);

    const after = await connect(shop.publicShopId);
    expect(after.statusCode).toBe(409);
    expect(after.json().error).toBe('SHOP_NOT_READY');
  });

  it('does not affect the legacy anonymous session route', async () => {
    // Regression guard: the anonymous path still mints a session with no shop linkage.
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body.joinToken).toEqual(expect.any(String));
    expect(body.shopId).toBeUndefined();
  });
});

describe('Phase F bridge — end-to-end JOIN by numericCode over WebSocket (§16)', () => {
  let app: FastifyInstance;
  let identityStore: MemoryIdentityStore;
  let port: number;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    identityStore = new MemoryIdentityStore();
    const built = await buildApp(undefined, identityStore);
    app = built.fastify;
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets a bridge customer JOIN with only the numericCode (no raw token)', async () => {
    // 1. Owner registers, creates a shop, brings it online, and opens a session.
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'ws-owner@shop.test', password: 'password-1234' },
    });
    const cookie = reg.cookies.find((c) => c.name === 'qd_auth')!.value;
    const shop = (await app.inject({
      method: 'POST',
      url: '/api/shops',
      cookies: { qd_auth: cookie },
      payload: { name: 'WS Shop' },
    })).json() as { publicShopId: string };
    await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: { deviceLabel: 'Counter' },
    });
    const opened = (await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/sessions`,
      cookies: { qd_auth: cookie },
      payload: {},
    })).json() as { sessionId: string; joinToken: string };

    // 2. Customer resolves the permanent QR via the public connect bridge.
    const bridged = (await app.inject({
      method: 'POST',
      url: `/api/public/shops/${shop.publicShopId}/connect`,
    })).json() as { sessionId: string; numericCode: string };
    expect(bridged.sessionId).toBe(opened.sessionId);

    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    // 3. Shop opens its signaling socket with the raw joinToken it received.
    const shopWs = new WebSocket(wsUrl);
    const shopMsgs: any[] = [];
    shopWs.on('message', (d) => shopMsgs.push(JSON.parse(d.toString())));
    await new Promise((r) => shopWs.on('open', r));
    shopWs.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: opened.joinToken, sessionId: opened.sessionId }));
    await new Promise((r) => setTimeout(r, 100));
    expect(shopMsgs.some((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'shop')).toBe(true);

    // 4. Customer JOINs using ONLY the numericCode from the bridge — no token field.
    const custWs = new WebSocket(wsUrl);
    const custMsgs: any[] = [];
    custWs.on('message', (d) => custMsgs.push(JSON.parse(d.toString())));
    await new Promise((r) => custWs.on('open', r));
    custWs.send(JSON.stringify({ type: 'JOIN', role: 'customer', numericCode: bridged.numericCode }));
    await new Promise((r) => setTimeout(r, 100));

    const custAccept = custMsgs.find((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'customer');
    expect(custAccept).toBeDefined();
    expect(custAccept.sessionId).toBe(opened.sessionId);
    // Shop sees the customer arrive → full P2P negotiation can proceed as before.
    expect(shopMsgs.some((m) => m.type === 'PEER_JOINED' && m.role === 'customer')).toBe(true);

    custWs.terminate();
    shopWs.terminate();
  });

  it('rejects a JOIN carrying no locator (token, numericCode, or sessionId)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));

    ws.send(JSON.stringify({ type: 'JOIN', role: 'customer' }));
    await new Promise((r) => setTimeout(r, 100));

    const rejection = msgs.find((m) => m.type === 'JOIN_REJECTED');
    expect(rejection).toBeDefined();
    expect(rejection.code).toBe('SESSION_NOT_FOUND');

    ws.close();
  });
});
