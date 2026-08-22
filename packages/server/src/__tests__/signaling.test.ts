import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { buildApp } from '../index.js';
import { FastifyInstance } from 'fastify';

describe('Phase 2 WebSocket Signaling & Session Locking', () => {
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

  it('connects shop and customer, performs join and relays SDP messages', async () => {
    // 1. Create session via REST
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const session = JSON.parse(createRes.body);

    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    // 2. Connect Shop WebSocket
    const shopWs = new WebSocket(wsUrl);
    const shopMessages: any[] = [];
    shopWs.on('message', (data) => {
      shopMessages.push(JSON.parse(data.toString()));
    });

    await new Promise((resolve) => shopWs.on('open', resolve));

    // Shop joins
    shopWs.send(
      JSON.stringify({
        type: 'JOIN',
        role: 'shop',
        token: session.joinToken,
        sessionId: session.sessionId,
      })
    );

    // Wait for JOIN_ACCEPTED on shop
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(shopMessages.some((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'shop')).toBe(true);

    // 3. Connect Customer WebSocket
    const customerWs = new WebSocket(wsUrl);
    const customerMessages: any[] = [];
    customerWs.on('message', (data) => {
      customerMessages.push(JSON.parse(data.toString()));
    });

    await new Promise((resolve) => customerWs.on('open', resolve));

    // Customer joins with joinToken
    customerWs.send(
      JSON.stringify({
        type: 'JOIN',
        role: 'customer',
        token: session.joinToken,
      })
    );

    // Wait for JOIN_ACCEPTED on customer and PEER_JOINED on shop
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(customerMessages.some((m) => m.type === 'JOIN_ACCEPTED' && m.role === 'customer')).toBe(true);
    expect(shopMessages.some((m) => m.type === 'PEER_JOINED' && m.role === 'customer')).toBe(true);

    // 4. Shop receives PEER_JOINED for customer
    const peerJoinedMsg = shopMessages.find((m) => m.type === 'PEER_JOINED');
    expect(peerJoinedMsg).toBeDefined();
    const customerPeerId = peerJoinedMsg.peerId;

    // 5. Shop sends OFFER targeting customer
    const offerSdp = { type: 'offer', sdp: 'fake-sdp-offer' };
    shopWs.send(
      JSON.stringify({
        type: 'OFFER',
        sdp: offerSdp,
        targetPeerId: customerPeerId,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const customerOffer = customerMessages.find((m) => m.type === 'OFFER');
    expect(customerOffer).toBeDefined();
    expect(customerOffer.sdp.sdp).toBe('fake-sdp-offer');

    // 6. Customer sends ANSWER (targetPeerId is optional since there's only 1 shop, but we can provide it)
    const answerSdp = { type: 'answer', sdp: 'fake-sdp-answer' };
    customerWs.send(
      JSON.stringify({
        type: 'ANSWER',
        sdp: answerSdp,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const shopAnswer = shopMessages.find((m) => m.type === 'ANSWER');
    expect(shopAnswer).toBeDefined();
    expect(shopAnswer.sdp.sdp).toBe('fake-sdp-answer');

    customerWs.terminate();
    shopWs.terminate();
  });

  it('allows multiple customers to join the same session concurrently', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    const { sessionId, joinToken } = JSON.parse(createRes.body);
    const shopWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    
    await new Promise((r) => shopWs.on('open', r));

    // Shop joins
    shopWs.send(
      JSON.stringify({
        type: 'JOIN',
        role: 'shop',
        token: joinToken,
        sessionId,
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    // Customer 1 joins
    const cust1Ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => cust1Ws.on('open', r));
    cust1Ws.send(
      JSON.stringify({
        type: 'JOIN',
        role: 'customer',
        token: joinToken,
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    // Customer 2 joins
    const cust2Ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => cust2Ws.on('open', r));
    const c2Msgs: any[] = [];
    cust2Ws.on('message', (data) => c2Msgs.push(JSON.parse(data.toString())));
    
    cust2Ws.send(
      JSON.stringify({
        type: 'JOIN',
        role: 'customer',
        token: joinToken,
      })
    );
    
    await new Promise((r) => setTimeout(r, 100));
    const joinAccepted = c2Msgs.find((m) => m.type === 'JOIN_ACCEPTED');
    expect(joinAccepted).toBeDefined();
    expect(joinAccepted.sessionId).toBe(sessionId);

    cust1Ws.terminate();
    cust2Ws.terminate();
    shopWs.terminate();
  });

  it('rejects invalid or non-existent token with JOIN_REJECTED', async () => {
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(wsUrl);
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));

    ws.send(
      JSON.stringify({
        type: 'JOIN',
        role: 'customer',
        token: 'completely-non-existent-fake-token',
      })
    );

    await new Promise((r) => setTimeout(r, 100));
    const rejection = msgs.find((m) => m.type === 'JOIN_REJECTED');
    expect(rejection).toBeDefined();
    expect(rejection.code).toBe('SESSION_NOT_FOUND');

    ws.close();
  });

  it('handles malformed WebSocket JSON without crashing server', async () => {
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(wsUrl);
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));

    // Send malformed non-JSON
    ws.send('NOT_VALID_JSON_STRING');

    await new Promise((r) => setTimeout(r, 100));
    const errMsg = msgs.find((m) => m.type === 'ERROR');
    expect(errMsg).toBeDefined();
    expect(errMsg.code).toBe('INVALID_JSON');

    // Send JSON with invalid schema type
    ws.send(JSON.stringify({ type: 'UNKNOWN_COMMAND_TYPE' }));
    await new Promise((r) => setTimeout(r, 100));
    const schemaErr = msgs.find((m) => m.code === 'INVALID_MESSAGE');
    expect(schemaErr).toBeDefined();

    ws.close();
  });

  it('BUG FIX: notifies waiting customers when shop joins an already-populated session', async () => {
    // This tests the root cause of the infinite CONNECTING hang:
    // Customer A connects first (shop is not open yet).
    // Shop then opens dashboard and joins.
    // Customer A MUST receive PEER_JOINED(shop) so it can begin WebRTC negotiation.

    const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    const { sessionId, joinToken } = JSON.parse(createRes.body);
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    // ── Step 1: Customer joins FIRST (shop not open) ─────────────────────────
    const custWs = new WebSocket(wsUrl);
    const custMsgs: any[] = [];
    custWs.on('message', (d) => custMsgs.push(JSON.parse(d.toString())));
    await new Promise((r) => custWs.on('open', r));

    custWs.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: joinToken }));
    await new Promise((r) => setTimeout(r, 100));

    const custJoin = custMsgs.find((m) => m.type === 'JOIN_ACCEPTED');
    expect(custJoin).toBeDefined();
    // At this point, customer has NOT received PEER_JOINED(shop) yet
    const shopJoinBeforeShopOpens = custMsgs.find((m) => m.type === 'PEER_JOINED' && m.role === 'shop');
    expect(shopJoinBeforeShopOpens).toBeUndefined();

    // ── Step 2: Shop opens dashboard and joins ───────────────────────────────
    const shopWs = new WebSocket(wsUrl);
    await new Promise((r) => shopWs.on('open', r));
    shopWs.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: joinToken, sessionId }));
    await new Promise((r) => setTimeout(r, 100));

    // ── Assertion: Customer MUST NOW have received PEER_JOINED(shop) ─────────
    const shopJoinMsg = custMsgs.find((m) => m.type === 'PEER_JOINED' && m.role === 'shop');
    expect(shopJoinMsg).toBeDefined();
    expect(shopJoinMsg.role).toBe('shop');
    // The shop's peerId must be set
    expect(typeof shopJoinMsg.peerId).toBe('string');
    expect(shopJoinMsg.peerId.length).toBeGreaterThan(0);

    custWs.terminate();
    shopWs.terminate();
  });
});
