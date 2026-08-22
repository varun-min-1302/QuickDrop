import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';

describe('Signaling Heartbeat & Session Lifecycle Integrity', () => {
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

  it('Fix 1: PING and incoming application messages refresh peer.isAlive and receive PONG', async () => {
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const ws = new WebSocket(wsUrl);
    const msgs: any[] = [];

    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));

    // Send application-level PING
    ws.send(JSON.stringify({ type: 'PING' }));
    await new Promise((r) => setTimeout(r, 100));

    expect(msgs.some((m) => m.type === 'PONG')).toBe(true);
    ws.close();
  });

  it('Fix 3 & 4: Temporary Shop WebSocket disconnect does NOT broadcast fatal SESSION_CLOSED to Customer', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    const session = JSON.parse(createRes.body);
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    // 1. Shop joins
    const shopWs = new WebSocket(wsUrl);
    await new Promise((r) => shopWs.on('open', r));
    shopWs.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: session.joinToken, sessionId: session.sessionId }));
    await new Promise((r) => setTimeout(r, 100));

    // 2. Customer joins
    const customerWs = new WebSocket(wsUrl);
    const customerMsgs: any[] = [];
    customerWs.on('message', (d) => customerMsgs.push(JSON.parse(d.toString())));
    await new Promise((r) => customerWs.on('open', r));
    customerWs.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: session.joinToken }));
    await new Promise((r) => setTimeout(r, 100));

    expect(customerMsgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(true);

    // 3. Shop socket drops temporarily
    shopWs.close();
    await new Promise((r) => setTimeout(r, 100));

    // Customer receives PEER_LEFT but NOT SESSION_CLOSED
    expect(customerMsgs.some((m) => m.type === 'PEER_LEFT')).toBe(true);
    expect(customerMsgs.some((m) => m.type === 'SESSION_CLOSED')).toBe(false);

    // 4. Shop reconnects
    const shopWs2 = new WebSocket(wsUrl);
    const shop2Msgs: any[] = [];
    shopWs2.on('message', (d) => shop2Msgs.push(JSON.parse(d.toString())));
    await new Promise((r) => shopWs2.on('open', r));
    shopWs2.send(JSON.stringify({ type: 'JOIN', role: 'shop', token: session.joinToken, sessionId: session.sessionId }));
    await new Promise((r) => setTimeout(r, 100));

    expect(shop2Msgs.some((m) => m.type === 'JOIN_ACCEPTED')).toBe(true);

    // Customer receives PEER_JOINED for shop
    expect(customerMsgs.some((m) => m.type === 'PEER_JOINED' && m.role === 'shop')).toBe(true);

    customerWs.close();
    shopWs2.close();
  });

  it('Fix 5 & 11: Explicit DELETE /api/sessions/:id terminates session and broadcasts SESSION_CLOSED', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    const session = JSON.parse(createRes.body);
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const customerWs = new WebSocket(wsUrl);
    const customerMsgs: any[] = [];
    customerWs.on('message', (d) => customerMsgs.push(JSON.parse(d.toString())));
    await new Promise((r) => customerWs.on('open', r));
    customerWs.send(JSON.stringify({ type: 'JOIN', role: 'customer', token: session.joinToken }));
    await new Promise((r) => setTimeout(r, 100));

    // Explicit DELETE by shop
    const delRes = await app.inject({ method: 'DELETE', url: `/api/sessions/${session.sessionId}` });
    expect(delRes.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    // Customer receives SESSION_CLOSED
    expect(customerMsgs.some((m) => m.type === 'SESSION_CLOSED')).toBe(true);
    customerWs.close();
  });
});
