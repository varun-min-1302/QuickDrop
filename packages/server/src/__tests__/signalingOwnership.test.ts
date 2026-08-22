import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { MemoryIdentityStore } from '../identity/index.js';

/**
 * Phase I — signaling shop-role ownership tightening (spec §I, additive).
 *
 * The permanent-QR bridge (§16) hands an unauthenticated customer a session's
 * `sessionId` + `numericCode`. Before this change the signaling shop path accepted a
 * bare `sessionId`, so a bridge customer could replay that id to JOIN as `role: 'shop'`
 * and impersonate the shop. The fix requires the raw `joinToken` (the server holds only
 * its hash) for the shop role and refuses a sessionId that disagrees with the token.
 *
 * These tests are purely additive: every pre-existing shop JOIN already sends a matching
 * token + sessionId pair, so the happy paths are unchanged (asserted below).
 */
describe('Phase I — signaling shop-role ownership tightening (§I additive)', () => {
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

  function openSocket(): Promise<{ ws: WebSocket; msgs: any[] }> {
    const ws = new WebSocket(wsUrl());
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    return new Promise((resolve) => ws.on('open', () => resolve({ ws, msgs })));
  }

  const settle = () => new Promise((r) => setTimeout(r, 100));

  async function createAnonymousSession() {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    return res.json() as { sessionId: string; joinToken: string; numericCode: string };
  }

  // ── The core hole: shop role by bare sessionId ────────────────────────────

  it('rejects a shop JOIN that presents only a sessionId (no token) with INVALID_TOKEN', async () => {
    const session = await createAnonymousSession();
    const { ws, msgs } = await openSocket();

    ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', sessionId: session.sessionId }));
    await settle();

    const rejection = msgs.find((m) => m.type === 'JOIN_REJECTED');
    expect(rejection).toBeDefined();
    expect(rejection.code).toBe('INVALID_TOKEN');
    // It must NOT have been accepted as the shop.
    expect(msgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(false);
    ws.terminate();
  });

  // ── The concrete attack: a bridge customer cannot become the shop ─────────

  it('stops a bridge customer from hijacking the shop role with the sessionId it was handed', async () => {
    // Owner brings a shop online and opens a shop-scoped session.
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'phase-i-owner@shop.test', password: 'password-1234' },
    });
    const cookie = reg.cookies.find((c) => c.name === 'qd_auth')!.value;
    const shop = (
      await app.inject({
        method: 'POST',
        url: '/api/shops',
        cookies: { qd_auth: cookie },
        payload: { name: 'Ownership Shop' },
      })
    ).json() as { publicShopId: string };
    await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: { deviceLabel: 'Counter' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/sessions`,
      cookies: { qd_auth: cookie },
      payload: {},
    });

    // Customer resolves the bridge — receives sessionId + numericCode, never the token.
    const bridged = (
      await app.inject({ method: 'POST', url: `/api/public/shops/${shop.publicShopId}/connect` })
    ).json() as { sessionId: string; numericCode: string };
    expect(bridged.sessionId).toEqual(expect.any(String));
    expect((bridged as any).joinToken).toBeUndefined();

    // Attack 1: replay the sessionId to claim the shop role → rejected.
    {
      const { ws, msgs } = await openSocket();
      ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', sessionId: bridged.sessionId }));
      await settle();
      const rejection = msgs.find((m) => m.type === 'JOIN_REJECTED');
      expect(rejection?.code).toBe('INVALID_TOKEN');
      expect(msgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(false);
      ws.terminate();
    }

    // Attack 2: pass the numericCode where a token belongs → it is not a valid token,
    // so it resolves to no session (SESSION_NOT_FOUND), never granting the shop role.
    {
      const { ws, msgs } = await openSocket();
      ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: bridged.numericCode }));
      await settle();
      const rejection = msgs.find((m) => m.type === 'JOIN_REJECTED');
      expect(rejection).toBeDefined();
      expect(rejection.code).toBe('SESSION_NOT_FOUND');
      expect(msgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(false);
      ws.terminate();
    }

    // The customer's legitimate path is untouched: JOIN as a customer by numericCode.
    {
      const { ws, msgs } = await openSocket();
      ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', numericCode: bridged.numericCode }));
      await settle();
      const accepted = msgs.find((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'customer');
      expect(accepted).toBeDefined();
      ws.terminate();
    }
  });

  // ── Mismatched credentials ────────────────────────────────────────────────

  it('rejects a shop JOIN whose sessionId does not match its token with INVALID_TOKEN', async () => {
    const sessionA = await createAnonymousSession();
    const sessionB = await createAnonymousSession();
    const { ws, msgs } = await openSocket();

    // Valid token for A, but the sessionId of a different (also valid) session B.
    ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: sessionA.joinToken, sessionId: sessionB.sessionId }));
    await settle();

    const rejection = msgs.find((m) => m.type === 'JOIN_REJECTED');
    expect(rejection).toBeDefined();
    expect(rejection.code).toBe('INVALID_TOKEN');
    expect(msgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(false);
    ws.terminate();
  });

  // ── Positive regressions: the legitimate shop paths still work ────────────

  it('accepts a shop JOIN with a matching token + sessionId (unchanged happy path)', async () => {
    const session = await createAnonymousSession();
    const { ws, msgs } = await openSocket();

    ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: session.joinToken, sessionId: session.sessionId }));
    await settle();

    expect(msgs.some((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'shop')).toBe(true);
    ws.terminate();
  });

  it('accepts a shop JOIN with the token alone (no sessionId) — the token is the credential', async () => {
    const session = await createAnonymousSession();
    const { ws, msgs } = await openSocket();

    ws.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: session.joinToken }));
    await settle();

    const accepted = msgs.find((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'shop');
    expect(accepted).toBeDefined();
    expect(accepted.sessionId).toBe(session.sessionId);
    ws.terminate();
  });
});
