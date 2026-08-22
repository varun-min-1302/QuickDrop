import { FastifyInstance } from 'fastify';
import { PublicShopIdSchema } from '@quickdrop/shared';
import { ShopService } from './shopService.js';

/**
 * Public, unauthenticated shop resolution for the customer flow (spec §4, §14).
 *
 * A customer scans the permanent QR — which encodes only the `publicShopId` (never a
 * secret or a transfer token) — and the client resolves it here to show the shop name
 * and whether it is online before attempting to connect.
 *
 * Effective path (mounted under `/api`): GET /api/public/shops/:publicShopId.
 */
export function registerPublicShopRoutes(
  fastify: FastifyInstance,
  shopService: ShopService,
  resolveRateLimitMaxPerMinute: number,
  done?: (err?: Error) => void
) {
  // Dedicated, tighter per-IP bucket (§J). Honoured when @fastify/rate-limit is
  // registered (dev/prod); a harmless no-op under test where the plugin is skipped.
  const rateLimitConfig = {
    rateLimit: { max: resolveRateLimitMaxPerMinute, timeWindow: '1 minute' },
  };

  fastify.get('/public/shops/:publicShopId', { config: rateLimitConfig }, async (request, reply) => {
    const parsed = PublicShopIdSchema.safeParse(
      (request.params as { publicShopId?: string }).publicShopId
    );
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_SHOP_CODE', message: 'Invalid shop code.' });
    }
    const resolved = await shopService.resolvePublicShop(parsed.data);
    if (!resolved) {
      return reply.status(404).send({ error: 'SHOP_NOT_FOUND', message: 'That shop code was not found.' });
    }
    return reply.status(200).send(resolved);
  });

  if (done) done();
}
