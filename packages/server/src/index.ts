import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import { ISessionStore, RedisSessionStore, MemorySessionStore } from './redis/sessionStore.js';
import { IIdentityStore, createIdentityStore } from './identity/index.js';
import { registerSessionRoutes } from './routes/sessionRoutes.js';
import { registerAuthRoutes } from './auth/authRoutes.js';
import { AuthService } from './auth/authService.js';
import { makeRequireAuth } from './auth/requireAuth.js';
import { ShopService } from './shop/shopService.js';
import { registerShopRoutes } from './shop/shopRoutes.js';
import { registerDashboardRoutes } from './shop/dashboardRoutes.js';
import { registerBridgeRoutes } from './shop/bridgeRoutes.js';
import { registerPublicShopRoutes } from './shop/publicShopRoutes.js';
import { SignalingManager } from './websocket/signalingServer.js';
import { generateSecureToken } from './utils/crypto.js';

export interface BuildAppOverrides {
  /**
   * Force the @fastify/rate-limit plugin on even under NODE_ENV=test. The plugin is
   * skipped by default in tests (so suites can fire many requests freely); the Phase J
   * rate-limit tests opt in via this flag to exercise the real buckets. No effect on
   * dev/prod, where rate limiting is always on.
   */
  forceRateLimit?: boolean;
  /** Override individual per-IP maxima (requests/minute). Each defaults to config. */
  rateLimits?: {
    global?: number;
    auth?: number;
    publicShop?: number;
    dashboardClaim?: number;
  };
}

export async function buildApp(
  customStore?: ISessionStore,
  customIdentityStore?: IIdentityStore,
  overrides?: BuildAppOverrides
) {
  const fastify = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
    trustProxy: true,
  });

  // Security headers with strict Content-Security-Policy
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'stun:', 'turn:'],
        objectSrc: ["'none'"],
        frameSrc: ["'self'", 'blob:'],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  });

  // Strict CORS policy
  const allowedOrigins = config.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, or same-origin server-to-server)
      if (!origin) return cb(null, true);

      if (config.NODE_ENV === 'production') {
        if (allowedOrigins.includes(origin)) {
          return cb(null, true);
        }
        return cb(new Error('CORS request rejected: Origin not allowed'), false);
      }

      // Development / Test: allow origin
      return cb(null, true);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Signed HttpOnly cookie support for owner auth sessions (spec §8).
  // COOKIE_SECRET is mandatory in production (like REDIS_URL); in dev/test we fall
  // back to an ephemeral per-process secret so signing still works locally.
  let cookieSecret = config.COOKIE_SECRET;
  if (!cookieSecret) {
    if (config.NODE_ENV === 'production') {
      throw new Error(
        'FATAL: COOKIE_SECRET is strictly required in production mode to sign authentication cookies.'
      );
    }
    cookieSecret = generateSecureToken();
  }
  await fastify.register(cookie, { secret: cookieSecret });

  // Rate limiting to prevent session creation spam and DoS. The global bucket applies to
  // all routes without their own config; sensitive endpoints (auth, public shop, dashboard
  // claim) attach tighter per-route buckets below. Skipped under test unless forced on so
  // the Phase J rate-limit suite can exercise the real buckets (§20, §J).
  const rateLimitEnabled = overrides?.forceRateLimit ?? (config.NODE_ENV !== 'test');
  const rateLimits = {
    global: overrides?.rateLimits?.global ?? config.RATE_LIMIT_MAX_PER_MINUTE,
    auth: overrides?.rateLimits?.auth ?? config.AUTH_RATE_LIMIT_MAX_PER_MINUTE,
    publicShop: overrides?.rateLimits?.publicShop ?? config.PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE,
    dashboardClaim: overrides?.rateLimits?.dashboardClaim ?? config.DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE,
  };
  if (rateLimitEnabled) {
    await fastify.register(rateLimit, {
      max: rateLimits.global,
      timeWindow: '1 minute',
      errorResponseBuilder: () => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please slow down your requests.',
      }),
    });
  }

  // Ephemeral Session Store
  let sessionStore: ISessionStore;
  if (customStore) {
    sessionStore = customStore;
  } else if (config.NODE_ENV === 'test') {
    sessionStore = new MemorySessionStore();
  } else if (config.NODE_ENV === 'production') {
    // Production Redis fallback MUST NOT be in-memory
    if (!config.REDIS_URL) {
      throw new Error(
        'FATAL: REDIS_URL is strictly required in production mode. In-memory session store is not permitted in production.'
      );
    }
    const redisStore = new RedisSessionStore(config.REDIS_URL);
    await redisStore.init();
    sessionStore = redisStore;
    fastify.log.info('Connected to Redis ephemeral store in production');
  } else if (config.REDIS_URL) {
    try {
      const redisStore = new RedisSessionStore(config.REDIS_URL);
      await redisStore.init();
      sessionStore = redisStore;
      fastify.log.info('Connected to Redis ephemeral store');
    } catch {
      fastify.log.warn('Could not connect to Redis, falling back to in-memory ephemeral store in development');
      sessionStore = new MemorySessionStore();
    }
  } else {
    sessionStore = new MemorySessionStore();
    fastify.log.info('Using in-memory ephemeral session store in development (TTL active)');
  }

  // Persistent identity store (users/shops/memberships/device-sessions/auth-sessions).
  // Separate lifecycle from the ephemeral transfer-session store above (spec §5, §17).
  let identityStore: IIdentityStore;
  if (customIdentityStore) {
    identityStore = customIdentityStore;
    await identityStore.init();
  } else {
    identityStore = await createIdentityStore();
  }

  const authService = new AuthService(identityStore, config.AUTH_SESSION_TTL_SECONDS);
  const shopService = new ShopService(identityStore, config.DASHBOARD_PRESENCE_TTL_SECONDS);
  const requireAuth = makeRequireAuth(authService);

  // WebSocket signaling gateway with message size & rate limits
  await fastify.register(fastifyWebsocket, {
    options: {
      maxPayload: config.MAX_WEBSOCKET_MESSAGE_BYTES,
    },
  });

  const signalingManager = new SignalingManager(sessionStore);

  fastify.get('/ws', { websocket: true }, (socket /* WebSocket */) => {
    signalingManager.handleConnection(socket);
  });

  // REST API Routes (all under /api)
  await fastify.register(
    (instance, _opts, done) => {
      registerAuthRoutes(
        instance,
        authService,
        {
          secure: config.NODE_ENV === 'production',
          authSessionTtlSeconds: config.AUTH_SESSION_TTL_SECONDS,
          authRateLimitMaxPerMinute: rateLimits.auth,
        },
        done
      );
    },
    { prefix: '/api' }
  );

  await fastify.register(
    (instance, _opts, done) => {
      registerShopRoutes(instance, shopService, requireAuth, done);
    },
    { prefix: '/api' }
  );

  await fastify.register(
    (instance, _opts, done) => {
      registerDashboardRoutes(instance, shopService, requireAuth, rateLimits.dashboardClaim, done);
    },
    { prefix: '/api' }
  );

  // Permanent-QR → transfer-session bridge (spec §16): authenticated shop-scoped
  // session open + public customer connect. Needs both the identity-backed shopService
  // and the ephemeral sessionStore, but stores no documents and no durable session state.
  await fastify.register(
    (instance, _opts, done) => {
      registerBridgeRoutes(instance, shopService, sessionStore, requireAuth, rateLimits.publicShop, done);
    },
    { prefix: '/api' }
  );

  await fastify.register(
    (instance, _opts, done) => {
      registerPublicShopRoutes(instance, shopService, rateLimits.publicShop, done);
    },
    { prefix: '/api' }
  );

  await fastify.register(
    (instance, opts, done) => {
      registerSessionRoutes(instance, sessionStore, signalingManager, opts, done);
    },
    { prefix: '/api' }
  );

  fastify.addHook('onClose', async () => {
    signalingManager.close();
    await sessionStore.close();
    await identityStore.close();
  });

  return { fastify, sessionStore, identityStore, authService, shopService, signalingManager };
}

// Start server if executed directly
if (process.env.NODE_ENV !== 'test') {
  buildApp()
    .then(({ fastify }) => {
      fastify.listen({ port: config.PORT, host: config.HOST }, (err, address) => {
        if (err) {
          fastify.log.error(err);
          process.exit(1);
        }
        fastify.log.info(`QuickDrop Signaling Server listening on ${address}`);
      });
    })
    .catch((err) => {
      console.error('Fatal error starting QuickDrop server:', err);
      process.exit(1);
    });
}
