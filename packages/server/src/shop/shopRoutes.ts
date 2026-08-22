import { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { CreateShopRequestSchema } from '@quickdrop/shared';
import { ShopService, ShopAccess } from './shopService.js';

const ShopParamSchema = z.object({
  id: z.string().uuid({ message: 'Shop id must be a valid UUID.' }),
});

/**
 * Owner shop-identity routes (spec §5, §6). All routes require an authenticated
 * owner session (`requireAuth`) and authorize ownership per shop:
 *   401 = not signed in · 403 = signed in but not a member · 404 = no such shop.
 *
 * Effective paths (mounted under `/api`): POST /api/shops, GET /api/shops,
 * GET /api/shops/:id, PATCH /api/shops/:id.
 */
export function registerShopRoutes(
  fastify: FastifyInstance,
  shopService: ShopService,
  requireAuth: preHandlerHookHandler,
  done?: (err?: Error) => void
) {
  // POST /shops — create the permanent shop and make the caller OWNER.
  fastify.post('/shops', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED' });

    const parsed = CreateShopRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'A shop name is required.' });
    }
    const summary = await shopService.createShop(user.id, parsed.data.name);
    return reply.status(201).send(summary);
  });

  // GET /shops — list the shops the caller belongs to.
  fastify.get('/shops', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED' });
    const shops = await shopService.listShops(user.id);
    return reply.status(200).send({ shops });
  });

  // GET /shops/:id — ownership-scoped read of one shop.
  fastify.get('/shops/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED' });
    const params = ShopParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'Invalid shop id.' });
    }
    const access = await shopService.getShopForUser(user.id, params.data.id);
    return sendAccess(reply, access);
  });

  // PATCH /shops/:id — rename a shop the caller owns.
  fastify.patch('/shops/:id', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.status(401).send({ error: 'UNAUTHENTICATED' });
    const params = ShopParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'Invalid shop id.' });
    }
    const parsed = CreateShopRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', message: 'A shop name is required.' });
    }
    const access = await shopService.renameShop(user.id, params.data.id, parsed.data.name);
    return sendAccess(reply, access);
  });

  if (done) done();
}

/** Translate a ShopAccess result into the correct HTTP status (§9 ladder). */
function sendAccess(reply: FastifyReply, access: ShopAccess) {
  if (access.kind === 'not_found') {
    return reply.status(404).send({ error: 'SHOP_NOT_FOUND', message: 'Shop not found.' });
  }
  if (access.kind === 'forbidden') {
    return reply.status(403).send({ error: 'FORBIDDEN', message: 'You do not have access to this shop.' });
  }
  return reply.status(200).send(access.summary);
}
