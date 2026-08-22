import { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { PublicShopIdSchema, ClaimDashboardRequestSchema } from '@quickdrop/shared';
import {
  ShopService,
  DashboardClaim,
  DashboardHeartbeat,
  DashboardRelease,
  DashboardStatus,
} from './shopService.js';

/** Body carrying the deviceSessionId returned by a prior claim. */
const DeviceSessionBodySchema = z.object({
  deviceSessionId: z.string().uuid({ message: 'deviceSessionId must be a valid UUID.' }),
});

/**
 * Dashboard-device lifecycle routes (spec §11, §12, §15, §21). These enforce the
 * ONE ACTIVE DASHBOARD DEVICE PER SHOP policy and drive online presence.
 *
 * All routes require an authenticated owner session (`requireAuth`) and authorize by
 * membership on the resolved shop — the browser-supplied `publicShopId` is only a
 * lookup key, never a credential. Effective paths (mounted under `/api`):
 *   POST /api/shops/:publicShopId/dashboard/claim
 *   POST /api/shops/:publicShopId/dashboard/heartbeat
 *   POST /api/shops/:publicShopId/dashboard/release
 *   GET  /api/shops/:publicShopId/dashboard
 */
export function registerDashboardRoutes(
  fastify: FastifyInstance,
  shopService: ShopService,
  requireAuth: preHandlerHookHandler,
  claimRateLimitMaxPerMinute: number,
  done?: (err?: Error) => void
) {
  // Dedicated, tighter per-IP bucket for the take-over-capable claim endpoint (§J).
  // Honoured when @fastify/rate-limit is registered (dev/prod); a no-op under test.
  const claimRateLimitConfig = {
    rateLimit: { max: claimRateLimitMaxPerMinute, timeWindow: '1 minute' },
  };

  // POST /shops/:publicShopId/dashboard/claim — become the shop's active dashboard.
  fastify.post(
    '/shops/:publicShopId/dashboard/claim',
    { preHandler: requireAuth, config: claimRateLimitConfig },
    async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED', message: 'You must be signed in.' });

    const pid = PublicShopIdSchema.safeParse((request.params as { publicShopId?: string }).publicShopId);
    if (!pid.success) {
      return reply.status(400).send({ error: 'INVALID_SHOP_CODE', message: 'Invalid shop code.' });
    }
    const body = ClaimDashboardRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'Invalid dashboard claim request.' });
    }

    const outcome = await shopService.claimDashboard(user.id, pid.data, {
      takeOver: body.data.takeOver,
      deviceLabel: body.data.deviceLabel,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return sendClaim(reply, outcome);
  });

  // POST /shops/:publicShopId/dashboard/heartbeat — refresh presence; detect take-over.
  fastify.post('/shops/:publicShopId/dashboard/heartbeat', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED', message: 'You must be signed in.' });

    const pid = PublicShopIdSchema.safeParse((request.params as { publicShopId?: string }).publicShopId);
    if (!pid.success) {
      return reply.status(400).send({ error: 'INVALID_SHOP_CODE', message: 'Invalid shop code.' });
    }
    const body = DeviceSessionBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'A deviceSessionId is required.' });
    }

    const outcome = await shopService.heartbeatDashboard(user.id, pid.data, body.data.deviceSessionId);
    return sendHeartbeat(reply, outcome);
  });

  // POST /shops/:publicShopId/dashboard/release — voluntarily give up the dashboard.
  fastify.post('/shops/:publicShopId/dashboard/release', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED', message: 'You must be signed in.' });

    const pid = PublicShopIdSchema.safeParse((request.params as { publicShopId?: string }).publicShopId);
    if (!pid.success) {
      return reply.status(400).send({ error: 'INVALID_SHOP_CODE', message: 'Invalid shop code.' });
    }
    const body = DeviceSessionBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'A deviceSessionId is required.' });
    }

    const outcome = await shopService.releaseDashboard(user.id, pid.data, body.data.deviceSessionId);
    return sendRelease(reply, outcome);
  });

  // GET /shops/:publicShopId/dashboard — current dashboard presence (§21 / take-over UI).
  fastify.get('/shops/:publicShopId/dashboard', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED', message: 'You must be signed in.' });

    const pid = PublicShopIdSchema.safeParse((request.params as { publicShopId?: string }).publicShopId);
    if (!pid.success) {
      return reply.status(400).send({ error: 'INVALID_SHOP_CODE', message: 'Invalid shop code.' });
    }
    const currentDeviceSessionId = (request.query as { deviceSessionId?: string } | undefined)?.deviceSessionId;
    const outcome = await shopService.getDashboardStatus(
      user.id,
      pid.data,
      typeof currentDeviceSessionId === 'string' ? currentDeviceSessionId : undefined
    );
    return sendStatus(reply, outcome);
  });

  if (done) done();
}

function shopNotFound(reply: FastifyReply) {
  return reply.status(404).send({ error: 'SHOP_NOT_FOUND', message: 'That shop was not found.' });
}
function forbidden(reply: FastifyReply) {
  return reply.status(403).send({ error: 'FORBIDDEN', message: 'You do not have access to this shop.' });
}

function sendClaim(reply: FastifyReply, outcome: DashboardClaim) {
  switch (outcome.kind) {
    case 'not_found':
      return shopNotFound(reply);
    case 'forbidden':
      return forbidden(reply);
    case 'conflict':
      return reply.status(409).send({
        error: 'DASHBOARD_ALREADY_ACTIVE',
        message: 'Another device is currently running this shop’s dashboard.',
        activeDevice: {
          deviceLabel: outcome.active.deviceLabel,
          connectedAt: outcome.active.connectedAt,
          lastSeenAt: outcome.active.lastSeenAt,
        },
      });
    case 'ok':
      return reply.status(200).send({ deviceSessionId: outcome.deviceSessionId, shop: outcome.summary });
  }
}

function sendHeartbeat(reply: FastifyReply, outcome: DashboardHeartbeat) {
  switch (outcome.kind) {
    case 'not_found':
      return shopNotFound(reply);
    case 'forbidden':
      return forbidden(reply);
    case 'revoked':
      return reply.status(409).send({
        error: 'DASHBOARD_REVOKED',
        message: 'This device is no longer the active dashboard — it was taken over on another device.',
      });
    case 'ok':
      return reply.status(200).send({ online: true, lastSeenAt: outcome.lastSeenAt });
  }
}

function sendRelease(reply: FastifyReply, outcome: DashboardRelease) {
  switch (outcome.kind) {
    case 'not_found':
      return shopNotFound(reply);
    case 'forbidden':
      return forbidden(reply);
    case 'ok':
      return reply.status(200).send({ released: true });
  }
}

function sendStatus(reply: FastifyReply, outcome: DashboardStatus) {
  switch (outcome.kind) {
    case 'not_found':
      return shopNotFound(reply);
    case 'forbidden':
      return forbidden(reply);
    case 'ok':
      return reply.status(200).send({ active: outcome.active, online: outcome.online });
  }
}
