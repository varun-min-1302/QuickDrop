import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../index.js';
import { FastifyInstance } from 'fastify';

describe('Server REST API & Session Lifecycle', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const built = await buildApp();
    app = built.fastify;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns healthy status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeTypeOf('number');
  });

  it('POST /api/sessions creates an ephemeral session with 15min TTL and protocolVersion', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        shopName: 'Main Campus Xerox',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBeDefined();
    expect(body.joinToken).toBeDefined();
    expect(body.numericCode).toHaveLength(6);
    expect(body.status).toBe('CREATED');
    expect(body.expiresAt).toBeDefined();
    expect(body.protocolVersion).toBe('1.0');
  });

  it('GET /api/sessions/:id/status returns status for created session', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const session = JSON.parse(createRes.body);

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.sessionId}/status`,
    });

    expect(statusRes.statusCode).toBe(200);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.sessionId).toBe(session.sessionId);
    expect(statusBody.status).toBe('CREATED');
    expect(statusBody.remainingSeconds).toBeGreaterThan(800);
    expect(statusBody.protocolVersion).toBe('1.0');
  });

  it('DELETE /api/sessions/:id terminates session early', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const session = JSON.parse(createRes.body);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.sessionId}`,
    });

    expect(deleteRes.statusCode).toBe(200);

    const statusRes = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.sessionId}/status`,
    });
    expect(statusRes.statusCode).toBe(404);
  });
});
