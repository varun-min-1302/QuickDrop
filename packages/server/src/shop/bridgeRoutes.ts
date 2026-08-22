import { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { PublicShopIdSchema, CreateSessionRequestSchema, LIMITS, PROTOCOL_VERSION } from '@quickdrop/shared';
import { ISessionStore } from '../redis/sessionStore.js';
import { ShopService } from './shopService.js';
import { createTransferSession } from '../session/transferSessionFactory.js';

/**
 * The permanent-QR → temporary-transfer-session bridge (spec §16). Two endpoints tie
 * the durable shop identity to the ephemeral session store WITHOUT rewriting the
 * transfer architecture and WITHOUT storing any document bytes:
 *
 *   POST /api/shops/:publicShopId/sessions   (auth) — a member opens a shop-scoped
 *       transfer session; the shop keeps the raw joinToken to JOIN as `shop`.
 *   POST /api/public/shops/:publicShopId/connect  (public) — a walk-in customer who
 *       scanned the permanent QR is routed to the shop's CURRENT live session, and
 *       receives that session's numericCode to JOIN as `customer`.
 *
 * The customer never receives a raw joinToken (the server only holds its hash); the
 * numericCode is the session's existing customer-join credential. Connection is refused
 * unless the shop is online (a dashboard is heartbeating) and a live session exists.
 */
export function registerBridgeRoutes(
  fastify: FastifyInstance,
  shopService: ShopService,
  sessionStore: ISessionStore,
  requireAuth: preHandlerHookHandler,
  connectRateLimitMaxPerMinute: number,
  done?: (err?: Error) => void
) {
  // Dedicated, tighter per-IP bucket for the public connect endpoint (§J). Honoured when
  // @fastify/rate-limit is registered (dev/prod); a no-op under test where it is skipped.
  const connectRateLimitConfig = {
    rateLimit: { max: connectRateLimitMaxPerMinute, timeWindow: '1 minute' },
  };

  // POST /shops/:publicShopId/sessions — authenticated, membership-scoped session open.
  fastify.post('/shops/:publicShopId/sessions', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED', message: 'You must be signed in.' });

    const pid = PublicShopIdSchema.safeParse((request.params as { publicShopId?: string }).publicShopId);
    if (!pid.success) {
      return reply.status(400).send({ error: 'INVALID_SHOP_CODE', message: 'Invalid shop code.' });
    }
    const body = CreateSessionRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'Invalid session request.' });
    }

    const access = await shopService.getShopForUserByPublicId(user.id, pid.data);
    if (access.kind === 'not_found') {
      return reply.status(404).send({ error: 'SHOP_NOT_FOUND', message: 'That shop was not found.' });
    }
    if (access.kind === 'forbidden') {
      return reply.status(403).send({ error: 'FORBIDDEN', message: 'You do not have access to this shop.' });
    }

    const ttlSeconds = body.data.ttlSeconds || LIMITS.DEFAULT_SESSION_TTL_SECONDS;
    const created = await createTransferSession(sessionStore, {
      shopName: access.summary.name,
      ttlSeconds,
      shopId: access.summary.id, // internal shopId links the session to the permanent shop
    });

    return reply.status(201).send({
      sessionId: created.sessionId,
      joinToken: created.joinToken,
      numericCode: created.numericCode,
      expiresAt: new Date(created.expiresAt).toISOString(),
      status: created.status,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  // POST /public/shops/:publicShopId/connect — unauthenticated customer bridge.
  fastify.post('/public/shops/:publicShopId/connect', { config: connectRateLimitConfig }, async (request, reply) => {
    const pid = PublicShopIdSchema.safeParse((request.params as { publicShopId?: string }).publicShopId);
    if (!pid.success) {
      return reply.status(400).send({ error: 'INVALID_SHOP_CODE', message: 'Invalid shop code.' });
    }

    const ctx = await shopService.getPublicShopConnectContext(pid.data);
    if (!ctx) {
      return reply.status(404).send({ error: 'SHOP_NOT_FOUND', message: 'That shop code was not found.' });
    }
    if (!ctx.online) {
      return reply.status(409).send({ error: 'SHOP_OFFLINE', message: 'This shop is not open right now.' });
    }

    const sessionId = await sessionStore.getShopCurrentSession(ctx.shopId);
    if (!sessionId) {
      return reply.status(409).send({ error: 'SHOP_NOT_READY', message: 'The shop has not started a transfer session yet.' });
    }

    const session = await sessionStore.getSession(sessionId);
    if (
      !session ||
      session.shopId !== ctx.shopId ||
      Date.now() >= session.expiresAt ||
      session.status === 'CLOSED' ||
      session.status === 'EXPIRED'
    ) {
      // Stale pointer (session gone/expired/mismatched) — clean up and report not-ready.
      await sessionStore.clearShopCurrentSession(ctx.shopId, sessionId);
      return reply.status(409).send({ error: 'SHOP_NOT_READY', message: 'The shop has not started a transfer session yet.' });
    }

    return reply.status(200).send({
      publicShopId: pid.data,
      name: ctx.name,
      sessionId: session.sessionId,
      numericCode: session.numericCode,
      expiresAt: session.expiresAt,
    });
  });

  if (done) done();
}
