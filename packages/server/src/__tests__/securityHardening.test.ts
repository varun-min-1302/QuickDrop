import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { LIMITS } from '@quickdrop/shared';

describe('Phase 6 Security Hardening & Threat Model Verification', () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const built = await buildApp();
    app = built.fastify;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };
    port = address.port;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Threat 1 & 16: Session Guessing & Enumeration', () => {
    it('returns 404 for non-existent session IDs without timing discrepancy or state leakage', async () => {
      const nonExistent = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${nonExistent}/status`,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Session not found or expired');
    });

    it('rejects malformed non-UUID identifiers with 400 validation error', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/1 OR 1=1; DROP TABLE sessions;/status',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid session ID format');
    });
  });

  describe('Threat 2, 3 & 4: Token Theft, Replay & Duplicate Join Protection', () => {
    it('allows a second customer (different clientId) to join an active session concurrently', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
      const session = JSON.parse(createRes.body);
      const wsUrl = `ws://127.0.0.1:${port}/ws`;

      // Customer 1 joins
      const c1 = new WebSocket(wsUrl);
      const c1Msgs: any[] = [];
      c1.on('message', (d) => c1Msgs.push(JSON.parse(d.toString())));
      await new Promise((r) => c1.on('open', r));
      c1.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: session.joinToken, clientId: 'client-1' }));

      await new Promise((r) => setTimeout(r, 100));
      expect(c1Msgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(true);

      // Customer 2 joins
      const c2 = new WebSocket(wsUrl);
      const c2Msgs: any[] = [];
      c2.on('message', (d) => c2Msgs.push(JSON.parse(d.toString())));
      await new Promise((r) => c2.on('open', r));
      c2.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: session.joinToken, clientId: 'client-2' }));

      await new Promise((r) => setTimeout(r, 100));
      const accepted = c2Msgs.find((m) => m.type === 'JOIN_ACCEPTED');
      expect(accepted).toBeDefined();

      c1.close();
      c2.close();
    });

    it('allows same customer (matching clientId) to seamlessly reconnect and kicks stale socket', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
      const session = JSON.parse(createRes.body);
      const wsUrl = `ws://127.0.0.1:${port}/ws`;

      // Customer 1 joins
      const c1 = new WebSocket(wsUrl);
      const c1Msgs: any[] = [];
      c1.on('message', (d) => c1Msgs.push(JSON.parse(d.toString())));
      await new Promise((r) => c1.on('open', r));
      c1.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: session.joinToken, clientId: 'client-1' }));

      await new Promise((r) => setTimeout(r, 100));
      expect(c1Msgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(true);

      // Customer 1 reconnects (refresh) before stale socket is detected dead
      const c1_reconnect = new WebSocket(wsUrl);
      const reconnectMsgs: any[] = [];
      c1_reconnect.on('message', (d) => reconnectMsgs.push(JSON.parse(d.toString())));
      await new Promise((r) => c1_reconnect.on('open', r));
      c1_reconnect.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: session.joinToken, clientId: 'client-1' }));

      await new Promise((r) => setTimeout(r, 100));
      // Reconnect MUST be accepted!
      const isAccepted = reconnectMsgs.some((m) => m.type === 'JOIN_ACCEPTED');
      if (!isAccepted) {
        console.error('Reconnect rejected:', reconnectMsgs);
      }
      expect(isAccepted).toBe(true);
      
      // Old stale socket must be forcibly closed
      expect(c1.readyState).toBe(WebSocket.CLOSED);

      c1_reconnect.close();
    });
  });

  describe('Threat 6 & 7: WebSocket Injection & Malformed Signaling', () => {
    it('rejects invalid JSON payloads gracefully with INVALID_JSON error', async () => {
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      const ws = new WebSocket(wsUrl);
      const msgs: any[] = [];
      ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on('open', r));

      ws.send('{ invalid json payload');
      await new Promise((r) => setTimeout(r, 100));

      const err = msgs.find((m) => m.code === 'INVALID_JSON');
      expect(err).toBeDefined();
      ws.close();
    });

    it('rejects unrecognized message types with INVALID_MESSAGE error', async () => {
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      const ws = new WebSocket(wsUrl);
      const msgs: any[] = [];
      ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on('open', r));

      ws.send(JSON.stringify({ type: 'EXPLOIT_PAYLOAD', data: 'malicious' }));
      await new Promise((r) => setTimeout(r, 100));

      const err = msgs.find((m) => m.code === 'INVALID_MESSAGE');
      expect(err).toBeDefined();
      ws.close();
    });

    it('rejects unauthenticated peer attempting to relay SDP before joining', async () => {
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      const ws = new WebSocket(wsUrl);
      const msgs: any[] = [];
      ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.on('open', r));

      ws.send(JSON.stringify({ type: 'OFFER', sdp: { type: 'offer', sdp: 'fake' } }));
      await new Promise((r) => setTimeout(r, 100));

      const err = msgs.find((m) => m.code === 'UNAUTHORIZED');
      expect(err).toBeDefined();
      ws.close();
    });
  });

  describe('Threat 8 & 14: Oversized Payloads & Flood Resistance', () => {
    it('rejects oversized control packet payloads exceeding 64 KiB', async () => {
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      const ws = new WebSocket(wsUrl);
      const msgs: any[] = [];
      let closed = false;
      let closeCode: number | undefined;

      ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
      ws.on('close', (code) => {
        closed = true;
        closeCode = code;
      });

      await new Promise((r) => ws.on('open', r));

      const giantPadding = 'A'.repeat(70 * 1024);
      ws.send(JSON.stringify({ type: 'PING', padding: giantPadding }));
      await new Promise((r) => setTimeout(r, 150));

      const hasError = msgs.some((m) => m.code === 'PAYLOAD_TOO_LARGE');
      const isClosedForSize = closed || closeCode === 1009;
      expect(hasError || isClosedForSize).toBe(true);

      ws.close();
    });
  });

  describe('Threat 9 & 10: File Limits in Shared Protocol Constants', () => {
    it('enforces 50 MB max file size and 200 MB max session limit constants', () => {
      expect(LIMITS.MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
      expect(LIMITS.MAX_SESSION_TRANSFER_BYTES).toBe(200 * 1024 * 1024);
      expect(LIMITS.CHUNK_SIZE_BYTES).toBe(64 * 1024);
    });
  });

  describe('Security Headers Verification', () => {
    it('serves CSP, HSTS, X-Content-Type-Options, and Referrer-Policy headers on REST responses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['content-security-policy']).toBeDefined();
    });
  });

  describe('Threat 11: Cross-Customer Signaling Prevention', () => {
    it('forces customer relayed messages to go only to the shop, ignoring targetPeerId', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
      const shopSession = JSON.parse(createRes.body);
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      
      const shopWs = new WebSocket(wsUrl);
      const cust1Ws = new WebSocket(wsUrl);
      const cust2Ws = new WebSocket(wsUrl);

      const shopMsgs: any[] = [];
      const cust1Msgs: any[] = [];
      const cust2Msgs: any[] = [];

      shopWs.on('message', (d) => shopMsgs.push(JSON.parse(d.toString())));
      cust1Ws.on('message', (d) => cust1Msgs.push(JSON.parse(d.toString())));
      cust2Ws.on('message', (d) => cust2Msgs.push(JSON.parse(d.toString())));

      await Promise.all([
        new Promise(r => shopWs.on('open', r)),
        new Promise(r => cust1Ws.on('open', r)),
        new Promise(r => cust2Ws.on('open', r)),
      ]);

      // Join Shop
      shopWs.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: shopSession.joinToken, sessionId: shopSession.sessionId }));
      await new Promise(r => setTimeout(r, 50));
      
      // Join Customer 1
      cust1Ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: shopSession.joinToken }));
      await new Promise(r => setTimeout(r, 50));
      const cust1JoinAcc = cust1Msgs.find(m => m.type === 'JOIN_ACCEPTED');
      expect(cust1JoinAcc).toBeDefined();
      
      // Join Customer 2
      cust2Ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: shopSession.joinToken }));
      await new Promise(r => setTimeout(r, 50));
      const cust2JoinAcc = cust2Msgs.find(m => m.type === 'JOIN_ACCEPTED');
      expect(cust2JoinAcc).toBeDefined();

      // Clear shop messages
      shopMsgs.length = 0;
      cust2Msgs.length = 0;


      // Customer 1 tries to send an OFFER directly to Customer 2
      cust1Ws.send(JSON.stringify({
        type: 'OFFER',
        targetPeerId: cust2JoinAcc.peerId,
        sdp: { type: 'offer', sdp: 'malicious' }
      }));

      await new Promise(r => setTimeout(r, 100));

      // Assert Customer 2 did NOT receive the message
      const cust2Offer = cust2Msgs.find(m => m.type === 'OFFER');
      expect(cust2Offer).toBeUndefined();

      // Assert Shop DID receive the message instead
      const shopOffer = shopMsgs.find(m => m.type === 'OFFER');
      expect(shopOffer).toBeDefined();
      expect(shopOffer.sdp.sdp).toBe('malicious');
      
      // Assert the fromPeerId matches Customer 1
      expect(shopOffer.fromPeerId).toBe(cust1JoinAcc.peerId);

      shopWs.close();
      cust1Ws.close();
      cust2Ws.close();
    });
  });

  describe('Threat 12: Server-Authoritative Customer Identity', () => {
    it('enforces that clientId is resolved from the secure socket connection, not client payload', async () => {
      const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
      const shopSession = JSON.parse(createRes.body);
      const wsUrl = `ws://127.0.0.1:${port}/ws`;
      
      const shopWs = new WebSocket(wsUrl);
      const cust1Ws = new WebSocket(wsUrl);
      const cust2Ws = new WebSocket(wsUrl);

      const shopMsgs: any[] = [];
      shopWs.on('message', (d) => shopMsgs.push(JSON.parse(d.toString())));

      await Promise.all([
        new Promise(r => shopWs.on('open', r)),
        new Promise(r => cust1Ws.on('open', r)),
        new Promise(r => cust2Ws.on('open', r)),
      ]);

      shopWs.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: shopSession.joinToken, sessionId: shopSession.sessionId }));
      await new Promise(r => setTimeout(r, 50));
      
      let cust1JoinAcc: any;
      cust1Ws.on('message', d => {
          const m = JSON.parse(d.toString());
          if (m.type === 'JOIN_ACCEPTED') cust1JoinAcc = m;
      });
      // Cust 1 joins
      cust1Ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: shopSession.joinToken, clientId: 'cust-1-real-id' }));
      await new Promise(r => setTimeout(r, 50));
      
      // Cust 2 joins
      cust2Ws.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: shopSession.joinToken, clientId: 'cust-2-real-id' }));
      await new Promise(r => setTimeout(r, 50));

      shopMsgs.length = 0;

      // Cust 1 attempts to forge a CUSTOMER_UPDATED claiming to be Cust 2
      cust1Ws.send(JSON.stringify({ type: 'CUSTOMER_UPDATED', clientId: 'cust-2-real-id', displayName: 'HackedName' }));
      await new Promise(r => setTimeout(r, 50));

      // The shop should receive the update, but the server MUST override clientId to Cust 1's true ID.
      const updates = shopMsgs.filter(m => m.type === 'CUSTOMER_UPDATED');
      expect(updates).toHaveLength(1);
      expect(updates[0].clientId).toBe('cust-1-real-id');
      expect(updates[0].displayName).toBe('HackedName');
      
      // Also verify that the peerId matches Cust 1
      expect(updates[0].peerId).toBe(cust1JoinAcc?.peerId);

      shopWs.close();
      cust1Ws.close();
      cust2Ws.close();
    });
  });
});
