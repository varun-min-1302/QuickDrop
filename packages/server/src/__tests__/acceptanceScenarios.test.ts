import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { ISessionStore } from '../redis/sessionStore.js';
import { MemoryIdentityStore } from '../identity/index.js';

/**
 * §31 FINAL ACCEPTANCE TEST — end-to-end verification of the 8 acceptance scenarios.
 *
 * This suite is PURELY ADDITIVE. It does not re-test what other suites already assert; it
 * closes only the genuine end-to-end gaps found while mapping each §31 scenario to code.
 * Nothing here touches the WebRTC / P2P document-transfer path — the permanent-shop-identity
 * ⟷ ephemeral-transfer-session ⟷ signaling boundary is exercised exactly as production does.
 *
 * Scenario → coverage map (verified 2026-08-22):
 *
 *   S1  Create account → create shop → permanent QR → print
 *         COVERED elsewhere: auth.test.ts (register + HttpOnly cookie, no secret leak),
 *         shop.test.ts (createShop → immutable publicShopId), client shopQr.test.ts
 *         (buildShopQrUrl → /s/:publicShopId). Physically PRINTING the poster is inherently
 *         manual (browser print dialog) and has no server-observable assertion.
 *
 *   S2  Customer scans QR → shop online → customer connects → sends documents
 *         COVERED elsewhere: client qrScanner.test.ts (scan → classify shop QR),
 *         bridge.test.ts + productionJourney.test.ts (online → /connect → WS JOIN). The final
 *         "sends documents" step is P2P WebRTC over the data channel — by design it never
 *         reaches the server, so it is not (and must not be) server-asserted.
 *
 *   S3  Transfer session expires → SAME printed QR scanned again → new temporary session
 *         → customer connects.                                     ← GAP, covered HERE.
 *
 *   S4  Shop closes dashboard → customer scans QR → "Shop currently unavailable".
 *   S5  Shop opens dashboard again → SAME permanent QR → customer can connect again.
 *                                                                  ← GAP, covered HERE (S4+S5).
 *
 *   S6  Laptop B → owner logs in → same shop → same permanent QR → dashboard available.
 *                                                                  ← GAP, covered HERE.
 *
 *   S7  Laptop A active → Laptop B → "Dashboard already active" → Take Over → A revoked → B active.
 *         COVERED elsewhere: dashboard.test.ts (409 DASHBOARD_ALREADY_ACTIVE → takeOver 200 →
 *         revoked device heartbeat 409) and productionJourney.test.ts (live session survives
 *         the take-over). Not duplicated here.
 *
 *   S8  Customers A + B + C → same permanent QR → all connect → multi-customer queue →
 *         documents remain correctly attributed.                  ← GAP, covered HERE (3 customers).
 */

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-only scenarios (S3, S4+S5, S6) — inject against buildApp.
// ─────────────────────────────────────────────────────────────────────────────

describe('§31 acceptance — session lifecycle & dashboard continuity (S3, S4+S5, S6)', () => {
  let app: FastifyInstance;
  let sessionStore: ISessionStore;
  let identityStore: MemoryIdentityStore;

  beforeEach(async () => {
    identityStore = new MemoryIdentityStore();
    const built = await buildApp(undefined, identityStore);
    app = built.fastify;
    sessionStore = built.sessionStore;
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const PASSWORD = 'password-1234';

  async function registerAndGetCookie(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return res.cookies.find((c) => c.name === 'qd_auth')!.value;
  }

  async function loginAndGetCookie(email: string, password = PASSWORD): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
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

  function listShops(cookie: string) {
    return app.inject({ method: 'GET', url: '/api/shops', cookies: { qd_auth: cookie } });
  }

  function claim(cookie: string, publicShopId: string, body: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: body,
    });
  }

  function release(cookie: string, publicShopId: string, deviceSessionId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/dashboard/release`,
      cookies: { qd_auth: cookie },
      payload: { deviceSessionId },
    });
  }

  function openSession(cookie: string, publicShopId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/sessions`,
      cookies: { qd_auth: cookie },
      payload: {},
    });
  }

  function connect(publicShopId: string) {
    return app.inject({ method: 'POST', url: `/api/public/shops/${publicShopId}/connect` });
  }

  function resolvePublic(publicShopId: string) {
    return app.inject({ method: 'GET', url: `/api/public/shops/${publicShopId}` });
  }

  it('S3: an expired transfer session frees the permanent QR to bridge a brand-new session', async () => {
    const cookie = await registerAndGetCookie('s3-owner@shop.test');
    const shop = await createShop(cookie, 'Expiry Shop');
    const PID = shop.publicShopId;
    await claim(cookie, PID, { deviceLabel: 'Counter' });

    // First transfer session: the printed QR bridges a customer to S1.
    const s1 = (await openSession(cookie, PID)).json() as { sessionId: string; numericCode: string };
    const first = await connect(PID);
    expect(first.statusCode).toBe(200);
    expect(first.json().sessionId).toBe(s1.sessionId);

    // The pointer key is the permanent (internal) shopId the session was created under —
    // read it from the session metadata rather than assuming it equals createShop().id.
    const s1meta = await sessionStore.getSession(s1.sessionId);
    const internalShopId = s1meta!.shopId!;
    expect(await sessionStore.getShopCurrentSession(internalShopId)).toBe(s1.sessionId);

    // The 15-minute session expires. (Route TTL min is 60s, so drive expiry deterministically
    // through the store instead of a wall-clock wait — the status flips to EXPIRED in place.)
    expect(await sessionStore.updateSessionStatus(s1.sessionId, 'EXPIRED')).toBe(true);

    // The SAME printed QR is scanned again. The bridge sees the stale/expired current session,
    // clears the dangling pointer, and reports the shop is simply not ready (NOT gone/offline).
    const stale = await connect(PID);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('SHOP_NOT_READY');
    expect(await sessionStore.getShopCurrentSession(internalShopId)).toBeNull();

    // The permanent identity is untouched — the shop is still online and resolvable.
    const resolved = await resolvePublic(PID);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ publicShopId: PID, online: true });

    // The owner starts a NEW transfer session; the same QR now bridges to S2.
    const s2 = (await openSession(cookie, PID)).json() as { sessionId: string; numericCode: string };
    expect(s2.sessionId).not.toBe(s1.sessionId);
    expect(s2.numericCode).not.toBe(s1.numericCode);
    const second = await connect(PID);
    expect(second.statusCode).toBe(200);
    expect(second.json().sessionId).toBe(s2.sessionId);
    expect(second.json().publicShopId).toBe(PID);
  });

  it('S4+S5: closing the dashboard makes the QR unavailable; reopening lets customers connect to the still-live session', async () => {
    const cookie = await registerAndGetCookie('s45-owner@shop.test');
    const shop = await createShop(cookie, 'Open Close Shop');
    const PID = shop.publicShopId;

    // Shop open with a live session: the QR connects.
    const device1 = (await claim(cookie, PID, { deviceLabel: 'Laptop A' })).json().deviceSessionId;
    const s1 = (await openSession(cookie, PID)).json() as { sessionId: string };
    expect((await connect(PID)).json().sessionId).toBe(s1.sessionId);

    // S4: the shop CLOSES the dashboard (owner leaves the counter).
    const released = await release(cookie, PID, device1);
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ released: true });

    // A customer scans the same QR → "Shop currently unavailable" (offline, not "not found").
    expect((await resolvePublic(PID)).json().online).toBe(false);
    const whileClosed = await connect(PID);
    expect(whileClosed.statusCode).toBe(409);
    expect(whileClosed.json().error).toBe('SHOP_OFFLINE');

    // S5: the shop OPENS the dashboard again (a fresh claim — no take-over needed, the prior
    // device was released, not still active). Same permanent QR, no new QR printed.
    const claimAgain = await claim(cookie, PID, { deviceLabel: 'Laptop A (reopened)' });
    expect(claimAgain.statusCode).toBe(200);
    expect(claimAgain.json().shop.publicShopId).toBe(PID);
    expect((await resolvePublic(PID)).json().online).toBe(true);

    // The customer can connect again. The transfer session is decoupled from the dashboard
    // device (§16): closing/reopening the dashboard did not destroy the live session, so the
    // SAME session is still bridgeable through the unchanged QR.
    const afterReopen = await connect(PID);
    expect(afterReopen.statusCode).toBe(200);
    expect(afterReopen.json().sessionId).toBe(s1.sessionId);
    expect(afterReopen.json().publicShopId).toBe(PID);
  });

  it('S6: a second laptop logging in as the owner resolves the same permanent shop and can open its dashboard', async () => {
    const email = 's6-owner@shop.test';

    // Laptop A: create the account (register) and the shop → permanent publicShopId.
    const cookieA = await registerAndGetCookie(email);
    const shop = await createShop(cookieA, 'One Shop Two Laptops');
    const PID = shop.publicShopId;

    // Laptop B: the SAME owner logs in fresh → a distinct auth session cookie.
    const cookieB = await loginAndGetCookie(email);
    expect(cookieB).toBeTruthy();
    expect(cookieB).not.toBe(cookieA);

    // Laptop B sees the SAME permanent shop identity (same publicShopId, same internal id).
    const list = (await listShops(cookieB)).json() as {
      shops: Array<{ id: string; publicShopId: string; name: string }>;
    };
    expect(list.shops).toHaveLength(1);
    expect(list.shops[0].publicShopId).toBe(PID);
    expect(list.shops[0].id).toBe(shop.id);
    expect(list.shops[0].name).toBe('One Shop Two Laptops');

    // Laptop B can open the dashboard (no incumbent device → clean claim, no take-over),
    // and the same permanent QR is now available/online.
    expect((await resolvePublic(PID)).json().online).toBe(false);
    const claimed = await claim(cookieB, PID, { deviceLabel: 'Laptop B' });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().shop.publicShopId).toBe(PID);
    expect((await resolvePublic(PID)).json().online).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-customer scenario (S8) — WebSocket end-to-end over the permanent-QR bridge.
// ─────────────────────────────────────────────────────────────────────────────

describe('§31 acceptance — three customers over the permanent-QR bridge (S8)', () => {
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

  const wsUrl = () => `ws://127.0.0.1:${port}/ws`;
  const settle = () => new Promise((r) => setTimeout(r, 120));

  function openSocket(): Promise<{ ws: WebSocket; msgs: any[] }> {
    const ws = new WebSocket(wsUrl());
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    return new Promise((resolve) => ws.on('open', () => resolve({ ws, msgs })));
  }

  async function bringShopOnline(email: string, name: string) {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'password-1234' },
    });
    const cookie = reg.cookies.find((c) => c.name === 'qd_auth')!.value;
    const shop = (
      await app.inject({ method: 'POST', url: '/api/shops', cookies: { qd_auth: cookie }, payload: { name } })
    ).json() as { publicShopId: string };
    await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: { deviceLabel: 'Counter' },
    });
    return { cookie, publicShopId: shop.publicShopId };
  }

  function openSession(cookie: string, publicShopId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/sessions`,
      cookies: { qd_auth: cookie },
      payload: {},
    });
  }

  function connect(publicShopId: string) {
    return app.inject({ method: 'POST', url: `/api/public/shops/${publicShopId}/connect` });
  }

  it('bridges customers A, B and C to one session; each JOINs and the shop sees three distinctly-attributed peers', async () => {
    const { cookie, publicShopId } = await bringShopOnline('s8-owner@shop.test', 'Three Customers Counter');
    const opened = (await openSession(cookie, publicShopId)).json() as { sessionId: string; joinToken: string };

    // Three independent walk-ins scan the SAME permanent QR → the SAME live session + numericCode.
    const bridges = [] as Array<{ sessionId: string; numericCode: string }>;
    for (let i = 0; i < 3; i++) {
      const r = await connect(publicShopId);
      expect(r.statusCode).toBe(200);
      bridges.push(r.json() as { sessionId: string; numericCode: string });
    }
    expect(bridges.every((b) => b.sessionId === opened.sessionId)).toBe(true);
    expect(new Set(bridges.map((b) => b.numericCode)).size).toBe(1); // one shared code for the session

    // The shop joins signaling with the raw token it holds.
    const shop = await openSocket();
    shop.ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: opened.joinToken, sessionId: opened.sessionId }));
    await settle();
    expect(shop.msgs.some((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'shop')).toBe(true);

    // Each customer JOINs with ONLY the bridged numericCode, under a distinct walk-in clientId.
    const clientIds = ['walkin-a', 'walkin-b', 'walkin-c'];
    const customers = [] as Array<{ ws: WebSocket; msgs: any[] }>;
    for (let i = 0; i < 3; i++) {
      const c = await openSocket();
      c.ws.send(
        JSON.stringify({ type: 'JOIN', role: 'customer', numericCode: bridges[i].numericCode, clientId: clientIds[i] })
      );
      customers.push(c);
      await settle();
    }

    // All three are accepted into the SAME session, each with its own server-assigned peerId.
    const accepts = customers.map((c) => c.msgs.find((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'customer'));
    expect(accepts.every((a) => a?.sessionId === opened.sessionId)).toBe(true);
    const customerPeerIds = accepts.map((a) => a!.peerId);
    expect(new Set(customerPeerIds).size).toBe(3); // distinct peers — the multi-customer queue

    // The shop sees all three arrive, each correctly attributed (distinct peerId AND clientId).
    // This is the server-side guarantee behind "documents remain correctly attributed".
    const peerJoins = shop.msgs.filter((m) => m.type === 'PEER_JOINED' && m.role === 'customer');
    expect(peerJoins.length).toBeGreaterThanOrEqual(3);
    const seenPeerIds = new Set(peerJoins.map((m) => m.peerId));
    for (const pid of customerPeerIds) expect(seenPeerIds.has(pid)).toBe(true);
    const seenClientIds = new Set(peerJoins.map((m) => m.customer?.clientId));
    for (const cid of clientIds) expect(seenClientIds.has(cid)).toBe(true);

    for (const c of customers) c.ws.terminate();
    shop.ws.terminate();
  });
});
