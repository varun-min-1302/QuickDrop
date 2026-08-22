import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { ISessionStore } from '../redis/sessionStore.js';
import { MemoryIdentityStore } from '../identity/index.js';

/**
 * Phase K — production-journey integration (spec §29K).
 *
 * The per-slice suites (auth, shop, dashboard, bridge, signalingOwnership) already cover
 * each endpoint in isolation. This suite is purely ADDITIVE and asserts the CROSS-CUTTING
 * architectural invariants that no single one of them proves end-to-end — the guarantees
 * the whole "permanent shop identity ≠ temporary transfer session ≠ ephemeral WebRTC"
 * separation exists to provide:
 *
 *   1. the permanent publicShopId (the QR) NEVER changes or expires when a transfer
 *      session ends — it simply re-bridges to the next session (§2, §16);
 *   2. resolving the permanent QR yields a stable identity whether the shop is offline,
 *      idle, or live (§4, §14);
 *   3. the live transfer session is decoupled from *which* dashboard device owns it — a
 *      take-over does not disturb an in-flight session (§12, §16, §17);
 *   4. neither the ephemeral session metadata nor the status API ever carries document
 *      content (ZERO DOCUMENT STORAGE, §17);
 *   5. multiple customers reach the SAME session THROUGH THE PUBLIC BRIDGE and both
 *      complete a signaling JOIN (multi-customer support preserved, §16);
 *   6. after a take-over the permanent QR still routes a fresh customer to the shop's
 *      current session, all the way to a WebSocket JOIN (§12 + §16 end-to-end).
 *
 * Nothing here modifies or replaces existing coverage; it only ties the pieces together.
 */

// The complete, intentional key set of an ephemeral transfer session (SessionMetadataSchema).
// `totalTransferredBytes` / `fileCount` are aggregate COUNTERS, not document content. Any new
// key here would be caught by the subset guard below — the tripwire for a zero-storage regression.
const SESSION_META_ALLOWED_KEYS = new Set([
  'sessionId',
  'tokenHash',
  'numericCode',
  'createdAt',
  'expiresAt',
  'status',
  'shopConnectionId',
  'customerCount',
  'shopName',
  'shopId',
  'totalTransferredBytes',
  'fileCount',
  'protocolVersion',
]);

const STATUS_ALLOWED_KEYS = new Set([
  'sessionId',
  'status',
  'hasShop',
  'customerCount',
  'expiresAt',
  'remainingSeconds',
  'protocolVersion',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Permanent identity ⟷ ephemeral session invariants (inject-only)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase K — permanent identity ⟷ ephemeral session invariants (§2/§14/§16/§17)', () => {
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

  function heartbeat(cookie: string, publicShopId: string, deviceSessionId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/dashboard/heartbeat`,
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

  function endSession(sessionId: string) {
    return app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` });
  }

  function connect(publicShopId: string) {
    return app.inject({ method: 'POST', url: `/api/public/shops/${publicShopId}/connect` });
  }

  function resolvePublic(publicShopId: string) {
    return app.inject({ method: 'GET', url: `/api/public/shops/${publicShopId}` });
  }

  it('keeps the permanent publicShopId stable across session churn and re-bridges to the newest session', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Corner Copy');
    const PID = shop.publicShopId;
    await claim(cookie, PID, { deviceLabel: 'Counter' });

    // First session: the QR bridges a customer to S1.
    const s1 = (await openSession(cookie, PID)).json() as { sessionId: string; numericCode: string };
    const bridged1 = await connect(PID);
    expect(bridged1.statusCode).toBe(200);
    expect(bridged1.json().sessionId).toBe(s1.sessionId);
    expect(bridged1.json().publicShopId).toBe(PID);

    // S1 ends. The shop is still online (dashboard heartbeating) — it is simply between
    // sessions, so the QR reports NOT_READY rather than dying.
    expect((await endSession(s1.sessionId)).statusCode).toBe(200);
    const between = await connect(PID);
    expect(between.statusCode).toBe(409);
    expect(between.json().error).toBe('SHOP_NOT_READY');

    // Second session under the SAME permanent shop: the QR now bridges to S2.
    const s2 = (await openSession(cookie, PID)).json() as { sessionId: string; numericCode: string };
    expect(s2.sessionId).not.toBe(s1.sessionId);
    expect(s2.numericCode).not.toBe(s1.numericCode);
    const bridged2 = await connect(PID);
    expect(bridged2.statusCode).toBe(200);
    expect(bridged2.json().sessionId).toBe(s2.sessionId);

    // The permanent identity is unchanged throughout: same publicShopId, same name.
    const list = (await app.inject({ method: 'GET', url: '/api/shops', cookies: { qd_auth: cookie } })).json();
    expect(list.shops).toHaveLength(1);
    expect(list.shops[0].publicShopId).toBe(PID);
    expect(list.shops[0].name).toBe('Corner Copy');
  });

  it('resolves a stable permanent identity whether the shop is offline, idle, or live', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Main Street Print');
    const PID = shop.publicShopId;

    const stateOf = async () => {
      const r = await resolvePublic(PID);
      expect(r.statusCode).toBe(200);
      return r.json() as { publicShopId: string; name: string; online: boolean };
    };

    // Offline (no dashboard): resolves the identity, reports offline, connect refused.
    const offline = await stateOf();
    expect(offline).toMatchObject({ publicShopId: PID, name: 'Main Street Print', online: false });
    expect((await connect(PID)).json().error).toBe('SHOP_OFFLINE');

    // Idle (dashboard online, no session): still the same identity, now online, but not ready.
    await claim(cookie, PID, { deviceLabel: 'Counter' });
    const idle = await stateOf();
    expect(idle).toMatchObject({ publicShopId: PID, name: 'Main Street Print', online: true });
    expect((await connect(PID)).json().error).toBe('SHOP_NOT_READY');

    // Live (session open): identity unchanged; connect succeeds.
    await openSession(cookie, PID);
    const live = await stateOf();
    expect(live).toMatchObject({ publicShopId: PID, name: 'Main Street Print', online: true });
    expect((await connect(PID)).statusCode).toBe(200);
  });

  it('keeps a live session bridgeable through a dashboard take-over (session decoupled from device)', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'Two Laptops');
    const PID = shop.publicShopId;

    // Laptop 1 claims the dashboard and opens the session a customer is mid-transfer on.
    const device1 = (await claim(cookie, PID, { deviceLabel: 'Laptop One' })).json().deviceSessionId;
    const s1 = (await openSession(cookie, PID)).json() as { sessionId: string };
    expect((await connect(PID)).json().sessionId).toBe(s1.sessionId);

    // Laptop 2 takes over. Laptop 1 loses the dashboard; laptop 2 heartbeats fine.
    const device2 = (await claim(cookie, PID, { deviceLabel: 'Laptop Two', takeOver: true })).json().deviceSessionId;
    expect(device2).not.toBe(device1);
    expect((await heartbeat(cookie, PID, device1)).statusCode).toBe(409);
    expect((await heartbeat(cookie, PID, device2)).statusCode).toBe(200);

    // The shop is still online and — crucially — the customer's session is STILL bridgeable.
    // The transfer session belongs to the permanent shop, not to whichever device is active.
    expect((await resolvePublic(PID)).json().online).toBe(true);
    const afterTakeover = await connect(PID);
    expect(afterTakeover.statusCode).toBe(200);
    expect(afterTakeover.json().sessionId).toBe(s1.sessionId);
    expect(afterTakeover.json().publicShopId).toBe(PID);
  });

  it('stores no document content in the ephemeral session metadata or the status API (zero storage §17)', async () => {
    const cookie = await registerAndGetCookie('owner@shop.test');
    const shop = await createShop(cookie, 'No Storage');
    await claim(cookie, shop.publicShopId, { deviceLabel: 'Counter' });
    const opened = (await openSession(cookie, shop.publicShopId)).json() as { sessionId: string };

    // The stored session metadata must contain only the known ephemeral fields — no bytes,
    // chunks, filenames, or document payloads ever land in the session store.
    const stored = await sessionStore.getSession(opened.sessionId);
    expect(stored).not.toBeNull();
    for (const key of Object.keys(stored!)) {
      expect(SESSION_META_ALLOWED_KEYS.has(key)).toBe(true);
    }
    for (const forbidden of ['files', 'documents', 'chunks', 'content', 'data', 'blob', 'buffer']) {
      expect(stored).not.toHaveProperty(forbidden);
    }

    // The public status API surface is likewise document-free.
    const status = await app.inject({ method: 'GET', url: `/api/sessions/${opened.sessionId}/status` });
    expect(status.statusCode).toBe(200);
    for (const key of Object.keys(status.json())) {
      expect(STATUS_ALLOWED_KEYS.has(key)).toBe(true);
    }
    expect(status.payload.toLowerCase()).not.toContain('filename');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-customer + take-over over the permanent-QR bridge (WebSocket end-to-end)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase K — multi-customer + take-over over the permanent-QR bridge (§16/§I)', () => {
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
    const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password-1234' } });
    const cookie = reg.cookies.find((c) => c.name === 'qd_auth')!.value;
    const shop = (await app.inject({
      method: 'POST',
      url: '/api/shops',
      cookies: { qd_auth: cookie },
      payload: { name },
    })).json() as { publicShopId: string };
    return { cookie, publicShopId: shop.publicShopId };
  }

  function claim(cookie: string, publicShopId: string, body: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/shops/${publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: body,
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

  it('bridges two customers to the same live session; both JOIN by numericCode and the shop sees both', async () => {
    const { cookie, publicShopId } = await bringShopOnline('multi-owner@shop.test', 'Busy Counter');
    await claim(cookie, publicShopId, { deviceLabel: 'Counter' });
    const opened = (await openSession(cookie, publicShopId)).json() as { sessionId: string; joinToken: string };

    // Two independent walk-in customers scan the SAME permanent QR → identical live session.
    const b1 = (await connect(publicShopId)).json() as { sessionId: string; numericCode: string };
    const b2 = (await connect(publicShopId)).json() as { sessionId: string; numericCode: string };
    expect(b1.sessionId).toBe(opened.sessionId);
    expect(b2.sessionId).toBe(opened.sessionId);
    expect(b2.numericCode).toBe(b1.numericCode);

    // Shop opens its signaling socket with the raw token it holds.
    const shop = await openSocket();
    shop.ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: opened.joinToken, sessionId: opened.sessionId }));
    await settle();
    expect(shop.msgs.some((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'shop')).toBe(true);

    // Both customers JOIN with ONLY the bridged numericCode, under distinct clientIds.
    const c1 = await openSocket();
    c1.ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', numericCode: b1.numericCode, clientId: 'walkin-1' }));
    await settle();
    const c2 = await openSocket();
    c2.ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', numericCode: b2.numericCode, clientId: 'walkin-2' }));
    await settle();

    const a1 = c1.msgs.find((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'customer');
    const a2 = c2.msgs.find((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'customer');
    expect(a1?.sessionId).toBe(opened.sessionId);
    expect(a2?.sessionId).toBe(opened.sessionId);

    // The shop sees BOTH customers arrive — multi-customer support is preserved through the bridge.
    const peerJoins = shop.msgs.filter((m) => m.type === 'PEER_JOINED' && m.role === 'customer');
    expect(peerJoins.length).toBeGreaterThanOrEqual(2);

    c1.ws.terminate();
    c2.ws.terminate();
    shop.ws.terminate();
  });

  it('after a take-over, the permanent QR routes a fresh customer to the new session all the way to a WS JOIN', async () => {
    const { cookie, publicShopId } = await bringShopOnline('takeover-owner@shop.test', 'Relocated Counter');

    // Laptop 1 is online with an initial session.
    await claim(cookie, publicShopId, { deviceLabel: 'Laptop One' });
    const s1 = (await openSession(cookie, publicShopId)).json() as { sessionId: string };

    // Owner moves to laptop 2 (take-over) and opens a fresh session there.
    await claim(cookie, publicShopId, { deviceLabel: 'Laptop Two', takeOver: true });
    const s2 = (await openSession(cookie, publicShopId)).json() as { sessionId: string; joinToken: string };
    expect(s2.sessionId).not.toBe(s1.sessionId);

    // A walk-in scans the SAME unchanged QR and is routed to the CURRENT (post-takeover) session.
    const bridged = (await connect(publicShopId)).json() as { sessionId: string; numericCode: string };
    expect(bridged.sessionId).toBe(s2.sessionId);

    // End-to-end: the relocated shop joins signaling for S2, the customer joins by the bridged
    // code, and the shop sees the peer — the permanent QR survived the device change intact.
    const shop = await openSocket();
    shop.ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: s2.joinToken, sessionId: s2.sessionId }));
    await settle();
    expect(shop.msgs.some((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'shop')).toBe(true);

    const cust = await openSocket();
    cust.ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', numericCode: bridged.numericCode, clientId: 'post-takeover' }));
    await settle();
    const accepted = cust.msgs.find((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'customer');
    expect(accepted?.sessionId).toBe(s2.sessionId);
    expect(shop.msgs.some((m) => m.type === 'PEER_JOINED' && m.role === 'customer')).toBe(true);

    cust.ws.terminate();
    shop.ws.terminate();
  });
});
