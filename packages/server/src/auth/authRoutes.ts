import { FastifyInstance } from 'fastify';
import { RegisterRequestSchema, LoginRequestSchema, MeResponse } from '@quickdrop/shared';
import { AuthService, EmailInUseError, InvalidCredentialsError } from './authService.js';
import { setAuthCookie, clearAuthCookie, readAuthToken } from './requireAuth.js';

export interface AuthRouteOptions {
  /** Set the Secure flag on the auth cookie (production/HTTPS only). */
  secure: boolean;
  /** Cookie + server-session lifetime, in seconds. */
  authSessionTtlSeconds: number;
  /** Per-IP attempts/minute for register + login (brute-force protection, §20). */
  authRateLimitMaxPerMinute: number;
}

/**
 * Owner authentication routes (spec §7–§9). Mounted under the `/api` prefix, so the
 * effective paths are /api/auth/register, /api/auth/login, /api/auth/logout,
 * /api/auth/me.
 *
 * Security invariants enforced here:
 *  - Passwords are validated then handed straight to the hashing service; they are
 *    never logged, echoed, or included in any response.
 *  - The session token lives ONLY in an HttpOnly, signed cookie — never in the body,
 *    never in localStorage, never in a URL.
 *  - 401 = not authenticated. (403 = authenticated-but-not-authorized, used later by
 *    shop-ownership checks.)
 */
export function registerAuthRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  opts: AuthRouteOptions,
  done?: (err?: Error) => void
) {
  // Per-route rate limit is honoured when @fastify/rate-limit is registered
  // (dev/prod) and is a harmless no-op under test where the plugin is skipped.
  const rateLimitConfig = {
    rateLimit: { max: opts.authRateLimitMaxPerMinute, timeWindow: '1 minute' },
  };

  const cookieOpts = { secure: opts.secure, maxAgeSeconds: opts.authSessionTtlSeconds };

  // POST /auth/register — create an owner account and start a session.
  fastify.post('/auth/register', { config: rateLimitConfig }, async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: 'Enter a valid email and a password of at least 8 characters.',
      });
    }
    try {
      const { user, token } = await authService.register(parsed.data.email, parsed.data.password);
      setAuthCookie(reply, token, cookieOpts);
      const body: MeResponse = { authenticated: true, user };
      return reply.status(201).send(body);
    } catch (err) {
      if (err instanceof EmailInUseError) {
        return reply.status(409).send({ error: 'EMAIL_IN_USE', message: err.message });
      }
      throw err;
    }
  });

  // POST /auth/login — verify credentials and start a session.
  fastify.post('/auth/login', { config: rateLimitConfig }, async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_REQUEST',
        message: 'Enter your email and password.',
      });
    }
    try {
      const { user, token } = await authService.login(parsed.data.email, parsed.data.password);
      setAuthCookie(reply, token, cookieOpts);
      const body: MeResponse = { authenticated: true, user };
      return reply.status(200).send(body);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return reply.status(401).send({ error: 'INVALID_CREDENTIALS', message: err.message });
      }
      throw err;
    }
  });

  // POST /auth/logout — revoke the current session. Idempotent.
  fastify.post('/auth/logout', async (request, reply) => {
    const token = readAuthToken(request);
    if (token) await authService.logout(token);
    clearAuthCookie(reply, opts.secure);
    return reply.status(200).send({ success: true });
  });

  // GET /auth/me — session probe. Always 200; body says whether authenticated.
  fastify.get('/auth/me', async (request, reply) => {
    const token = readAuthToken(request);
    const session = token ? await authService.validateToken(token) : null;
    const body: MeResponse = session
      ? { authenticated: true, user: session.user }
      : { authenticated: false };
    return reply.status(200).send(body);
  });

  if (done) done();
}
