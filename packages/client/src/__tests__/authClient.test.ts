import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ApiError,
  apiRequest,
  buildHeaders,
  defaultMessageForStatus,
  isDev,
} from '../lib/api/http.js';
import { registerOwner, loginOwner, logoutOwner, fetchMe } from '../lib/api/auth.js';
import { authReducer, initialAuthState } from '../auth/authState.js';

/**
 * Sub-phase 1 (client auth foundation) test gate. Pure logic + a stubbed `fetch`, matching
 * the repo's Node test environment (no DOM rendering / testing-library). Proves the API
 * layer keeps the auth security invariants (credentials included, password only in the
 * POST body, typed error envelope) and that the auth reducer transitions correctly.
 */

/** Build a minimal fetch-`Response` stand-in sufficient for {@link apiRequest}. */
function fakeResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => body,
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('http helpers (pure)', () => {
  it('buildHeaders: Accept always; Content-Type only with a body; ngrok header only in dev', () => {
    expect(buildHeaders(false, false)).toEqual({ Accept: 'application/json' });
    expect(buildHeaders(true, false)).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(buildHeaders(false, true)).toEqual({
      Accept: 'application/json',
      'ngrok-skip-browser-warning': 'true',
    });
  });

  it('defaultMessageForStatus: distinct, display-safe messages per status class', () => {
    expect(defaultMessageForStatus(401)).toMatch(/sign in/i);
    expect(defaultMessageForStatus(403)).toMatch(/access/i);
    expect(defaultMessageForStatus(404)).toMatch(/find/i);
    expect(defaultMessageForStatus(409)).toMatch(/conflict/i);
    expect(defaultMessageForStatus(429)).toMatch(/too many/i);
    expect(defaultMessageForStatus(500)).toMatch(/server/i);
    // Never leaks internals.
    expect(defaultMessageForStatus(418)).not.toMatch(/stack|trace|undefined/i);
  });

  it('isDev never throws (safe in the Node test env)', () => {
    expect(() => isDev()).not.toThrow();
    expect(typeof isDev()).toBe('boolean');
  });
});

describe('apiRequest (via a stubbed fetch)', () => {
  it('sends credentials:include and returns the parsed JSON body on 2xx', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { authenticated: false }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await apiRequest<{ authenticated: boolean }>('/api/auth/me');

    expect(out).toEqual({ authenticated: false });
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({ Accept: 'application/json' });
    // No body ⇒ no Content-Type.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('throws ApiError carrying the server {error,message} envelope on non-2xx', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        fakeResponse(409, { error: 'EMAIL_IN_USE', message: 'That email is already registered.' })
      ) as unknown as typeof fetch;

    const err = (await apiRequest('/api/auth/register', { method: 'POST', body: {} }).catch(
      (e) => e
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('EMAIL_IN_USE');
    expect(err.message).toBe('That email is already registered.');
  });

  it('falls back to a status-based message when the error body is not JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(fakeResponse(429, '<html>rate limited</html>', 'text/html')) as unknown as typeof fetch;

    const err = (await apiRequest('/api/auth/login', { method: 'POST', body: {} }).catch(
      (e) => e
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('REQUEST_FAILED');
    expect(err.message).toMatch(/too many/i);
  });

  it('wraps a transport failure as ApiError(0, NETWORK)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('failed to fetch')) as unknown as typeof fetch;

    const err = (await apiRequest('/api/auth/me').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK');
  });

  it('re-throws an AbortError as-is (not wrapped) so callers can detect cancellation', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    globalThis.fetch = vi.fn().mockRejectedValue(abort) as unknown as typeof fetch;

    const err = await apiRequest('/api/auth/me').catch((e) => e);
    expect(err).toBe(abort);
    expect(err).not.toBeInstanceOf(ApiError);
  });
});

describe('auth API calls', () => {
  it('registerOwner POSTs to /api/auth/register with the credentials in the JSON body', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(fakeResponse(201, { authenticated: true, user: { id: 'u', email: 'a@b.co', createdAt: 1 } }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const me = await registerOwner('Owner@Shop.CO', 'password-1234');
    expect(me.authenticated).toBe(true);
    expect(me.user?.email).toBe('a@b.co');

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/auth/register');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ email: 'Owner@Shop.CO', password: 'password-1234' });
  });

  it('loginOwner keeps the password out of the URL and headers (only in the body)', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(fakeResponse(200, { authenticated: true, user: { id: 'u', email: 'a@b.co', createdAt: 1 } }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const secret = 'sup3r-secret-pw';
    await loginOwner('a@b.co', secret);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(String(url)).not.toContain(secret);
    expect(JSON.stringify(init.headers)).not.toContain(secret);
    expect(JSON.parse(init.body).password).toBe(secret);
  });

  it('logoutOwner POSTs to /api/auth/logout and returns the success flag', async () => {
    const spy = vi.fn().mockResolvedValue(fakeResponse(200, { success: true }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const out = await logoutOwner();
    expect(out).toEqual({ success: true });
    expect(spy.mock.calls[0][0]).toBe('/api/auth/logout');
    expect(spy.mock.calls[0][1].method).toBe('POST');
  });

  it('fetchMe GETs /api/auth/me and surfaces the authenticated flag', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(fakeResponse(200, { authenticated: true, user: { id: 'u', email: 'a@b.co', createdAt: 1 } }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const me = await fetchMe();
    expect(me.authenticated).toBe(true);
    expect(spy.mock.calls[0][0]).toBe('/api/auth/me');
    expect(spy.mock.calls[0][1].method).toBe('GET');
  });
});

describe('authReducer (pure state transitions)', () => {
  it('starts loading and resolves to authenticated when a user is present', () => {
    expect(initialAuthState).toEqual({ status: 'loading', user: null });
    const user = { id: 'u1', email: 'owner@shop.co', createdAt: 1 };
    const next = authReducer(initialAuthState, { type: 'RESOLVED', user });
    expect(next).toEqual({ status: 'authenticated', user });
  });

  it('resolves to unauthenticated when no user is returned', () => {
    const next = authReducer({ status: 'authenticated', user: { id: 'u', email: 'a@b.co', createdAt: 1 } }, {
      type: 'RESOLVED',
      user: null,
    });
    expect(next).toEqual({ status: 'unauthenticated', user: null });
  });

  it('LOGGED_OUT always clears the user', () => {
    const next = authReducer({ status: 'authenticated', user: { id: 'u', email: 'a@b.co', createdAt: 1 } }, {
      type: 'LOGGED_OUT',
    });
    expect(next).toEqual({ status: 'unauthenticated', user: null });
  });

  it('LOADING preserves the last known user (avoids a flash of signed-out UI on re-probe)', () => {
    const user = { id: 'u', email: 'a@b.co', createdAt: 1 };
    const next = authReducer({ status: 'authenticated', user }, { type: 'LOADING' });
    expect(next).toEqual({ status: 'loading', user });
  });
});
