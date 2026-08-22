import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import {
  CreateSessionRequestSchema,
  LIMITS,
  PROTOCOL_VERSION,
} from '@quickdrop/shared';
import { ISessionStore } from '../redis/sessionStore.js';
import { SignalingManager } from '../websocket/signalingServer.js';
import { createTransferSession } from '../session/transferSessionFactory.js';

const SessionParamSchema = z.object({
  id: z.string().uuid({ message: 'Session ID must be a valid UUID v4' }),
});

export function registerSessionRoutes(
  fastify: FastifyInstance,
  sessionStore: ISessionStore,
  signalingManager?: SignalingManager,
  _opts?: FastifyPluginOptions,
  done?: (err?: Error) => void
) {
  // Healthcheck endpoint
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
    };
  });

  // POST /api/sessions - Create temporary transfer session (legacy anonymous path).
  // Shop-scoped creation lives at POST /api/shops/:publicShopId/sessions (bridgeRoutes).
  fastify.post('/sessions', async (request, reply) => {
    const parseResult = CreateSessionRequestSchema.safeParse(request.body || {});
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid session request',
        details: parseResult.error.errors,
      });
    }

    const { shopName, ttlSeconds } = parseResult.data;
    const effectiveTTL = ttlSeconds || LIMITS.DEFAULT_SESSION_TTL_SECONDS;
    const created = await createTransferSession(sessionStore, { shopName, ttlSeconds: effectiveTTL });

    return reply.status(201).send({
      sessionId: created.sessionId,
      joinToken: created.joinToken,
      numericCode: created.numericCode,
      expiresAt: new Date(created.expiresAt).toISOString(),
      status: created.status,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  // GET /api/sessions/:id/status - Check session status
  fastify.get('/sessions/:id/status', async (request, reply) => {
    const paramResult = SessionParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Invalid session ID format',
        details: paramResult.error.errors,
      });
    }

    const { id } = paramResult.data;
    const session = await sessionStore.getSession(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found or expired' });
    }

    const remainingSeconds = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));

    return reply.send({
      sessionId: session.sessionId,
      status: session.status,
      hasShop: !!session.shopConnectionId,
      customerCount: session.customerCount || 0,
      expiresAt: new Date(session.expiresAt).toISOString(),
      remainingSeconds,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  // DELETE /api/sessions/:id - End session early
  fastify.delete('/sessions/:id', async (request, reply) => {
    const paramResult = SessionParamSchema.safeParse(request.params);
    if (!paramResult.success) {
      return reply.status(400).send({
        error: 'Invalid session ID format',
        details: paramResult.error.errors,
      });
    }

    const { id } = paramResult.data;
    const session = await sessionStore.getSession(id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    await sessionStore.deleteSession(id);
    if (signalingManager) {
      signalingManager.terminateSession(id, 'Shop ended the transfer session.');
    }
    return reply.send({ success: true, message: 'Session terminated' });
  });

  if (done) done();
}
