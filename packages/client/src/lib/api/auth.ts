/**
 * Owner-authentication API calls (spec §7–§9). Thin, typed wrappers over {@link apiRequest}.
 *
 * Security notes:
 *  - The password is sent ONLY in the POST body of register/login (over the same-origin
 *    proxied `/api`, HTTPS in production). It is never placed in a URL or query string,
 *    never persisted, and never logged.
 *  - The session credential is the HttpOnly `qd_auth` cookie set by the server; JS never
 *    sees it. `fetchMe()` is the only source of client-visible "am I signed in" state.
 */
import type { MeResponse } from '@quickdrop/shared';
import { apiRequest } from './http.js';

/** POST /api/auth/register — create an owner account and start a session. */
export function registerOwner(email: string, password: string, signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest<MeResponse>('/api/auth/register', {
    method: 'POST',
    body: { email, password },
    signal,
  });
}

/** POST /api/auth/login — verify credentials and start a session. */
export function loginOwner(email: string, password: string, signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest<MeResponse>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    signal,
  });
}

/** POST /api/auth/logout — revoke the current session. Idempotent server-side. */
export function logoutOwner(signal?: AbortSignal): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>('/api/auth/logout', { method: 'POST', signal });
}

/** GET /api/auth/me — session probe. Always 200; body says whether authenticated. */
export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return apiRequest<MeResponse>('/api/auth/me', { method: 'GET', signal });
}
