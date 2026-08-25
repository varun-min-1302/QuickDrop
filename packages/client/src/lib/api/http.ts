/**
 * Minimal typed HTTP client for QuickDrop's REST API (spec §7–§16 owner/shop endpoints).
 *
 * Every call goes through {@link apiRequest}, which centralises the security-critical
 * invariants so no individual caller can get them wrong:
 *
 *  - `credentials: 'include'` on every request, so the HttpOnly, signed `qd_auth` cookie
 *    is sent and refreshed. The auth token is NEVER read/written by JS and NEVER placed in
 *    localStorage, a header, a query string, or a request body (spec §8).
 *  - JSON in, JSON out, with defensive parsing: a proxy interstitial (e.g. the ngrok
 *    warning page) returns HTML, not JSON — we must not blow up trying to `.json()` it.
 *  - A single {@link ApiError} shape carrying the server's `{ error, message }` envelope
 *    (spec §9/§23) so UI code has one thing to catch and one message to show.
 *
 * This module is intentionally free of any React/DOM dependency so its logic can be unit
 * tested in the Node test environment by stubbing `globalThis.fetch`.
 */

/** Structured error for any non-2xx response or transport failure. */
export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 for a transport/network failure before any response. */
    public readonly status: number,
    /** Machine-readable code from the server envelope (`error`), or a synthetic one. */
    public readonly code: string,
    /** Human-readable, display-safe message. */
    message: string,
    /**
     * The full parsed JSON error body, when the server sent one. Most callers only need
     * `status`/`code`/`message`, but some 409s carry extra structured detail (e.g. the
     * dashboard-claim conflict's `activeDevice`) that a specific caller must surface.
     */
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  /** JSON-serialisable body. Presence toggles the `Content-Type: application/json` header. */
  body?: unknown;
  /** Optional abort signal so callers can cancel in-flight requests on unmount. */
  signal?: AbortSignal;
}

/**
 * Gets the base API URL from environment variables, or empty string if not set.
 * Guarded so it is safe in the Node test environment where `import.meta.env` may be absent.
 */
export function getApiBaseUrl(): string {
  try {
    return (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || '';
  } catch {
    return '';
  }
}

/** Build the request headers. Pure so it can be asserted directly in tests. */
export function buildHeaders(hasJsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (hasJsonBody) headers['Content-Type'] = 'application/json';
  return headers;
}

/** Generic, display-safe fallback message when the server sends no `message`. */
export function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'That request was invalid. Please check your input and try again.';
    case 401:
      return 'Please sign in to continue.';
    case 403:
      return 'You do not have access to this shop.';
    case 404:
      return 'We could not find what you were looking for.';
    case 409:
      return 'That action conflicts with the current state.';
    case 429:
      return 'Too many requests. Please slow down and try again shortly.';
    default:
      return status >= 500
        ? 'The server ran into a problem. Please try again in a moment.'
        : 'Something went wrong. Please try again.';
  }
}

/** Parse a JSON body, tolerating non-JSON responses (proxy pages, empty bodies). */
async function safeParseJson(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function readEnvelope(parsed: unknown): { error?: string; message?: string } {
  return parsed && typeof parsed === 'object' ? (parsed as { error?: string; message?: string }) : {};
}

/**
 * Perform an API request and return the parsed JSON body typed as `T`.
 * Throws {@link ApiError} on any non-2xx response or transport failure. An `AbortError`
 * from a cancelled request is re-thrown as-is so callers can distinguish cancellation.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const hasJsonBody = body !== undefined && body !== null;

  const baseUrl = getApiBaseUrl();
  const fullPath = baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path;

  let res: Response;
  try {
    res = await fetch(fullPath, {
      method,
      credentials: 'include',
      headers: buildHeaders(hasJsonBody),
      body: hasJsonBody ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Could not reach the QuickDrop server. Check your connection.');
  }

  const parsed = await safeParseJson(res);

  if (!res.ok) {
    const envelope = readEnvelope(parsed);
    const code = typeof envelope.error === 'string' ? envelope.error : 'REQUEST_FAILED';
    const message =
      typeof envelope.message === 'string' && envelope.message.trim().length > 0
        ? envelope.message
        : defaultMessageForStatus(res.status);
    throw new ApiError(res.status, code, message, parsed ?? undefined);
  }

  return parsed as T;
}
