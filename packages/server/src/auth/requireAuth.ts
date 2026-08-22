import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '@quickdrop/shared';
import { AuthService } from './authService.js';

/** Name of the HttpOnly cookie carrying the (signed) raw session token. */
export const AUTH_COOKIE_NAME = 'qd_auth';

// Attach the authenticated principal to the request for downstream handlers.
declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    authSessionId?: string;
  }
}

/**
 * Read and unsign the raw session token from the auth cookie.
 * Returns null when the cookie is absent or its signature does not verify.
 */
export function readAuthToken(request: FastifyRequest): string | null {
  const raw = request.cookies[AUTH_COOKIE_NAME];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  return unsigned.value;
}

interface AuthCookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/** Set the HttpOnly, signed auth cookie. The token is never exposed to JavaScript. */
export function setAuthCookie(reply: FastifyReply, token: string, opts: AuthCookieOptions): void {
  reply.setCookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    signed: true,
    maxAge: opts.maxAgeSeconds,
  });
}

/** Clear the auth cookie (logout). */
export function clearAuthCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    signed: true,
  });
}

/**
 * Build a preHandler that requires a valid owner session. On success it attaches
 * `request.authUser` + `request.authSessionId`; otherwise it replies 401 and the
 * route handler never runs (spec §9: 401 = unauthenticated).
 */
export function makeRequireAuth(authService: AuthService) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = readAuthToken(request);
    const session = token ? await authService.validateToken(token) : null;
    if (!session) {
      await reply.status(401).send({ error: 'UNAUTHENTICATED', message: 'You must be signed in.' });
      return;
    }
    request.authUser = session.user;
    request.authSessionId = session.authSessionId;
  };
}
