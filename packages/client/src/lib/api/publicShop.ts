import type { PublicShopResolveResponse, PublicShopConnectResponse } from '@quickdrop/shared';
import { apiRequest, ApiError } from './http.js';

/**
 * Customer-facing PUBLIC shop endpoints for the permanent-QR flow (spec §4/§14/§16).
 * These are the only endpoints a walk-in customer (anonymous, no cookie) calls:
 *
 *   GET  /api/public/shops/:publicShopId          — resolve a scanned QR to {name, online}.
 *   POST /api/public/shops/:publicShopId/connect  — bridge to the shop's CURRENT transfer
 *                                                   session, returning its numericCode.
 *
 * The customer never receives a raw joinToken (the server only holds its hash); the
 * `numericCode` is the session's existing customer-join credential (§16). As with the
 * dashboard client, the *expected* non-fatal states (shop closed / not yet open) are
 * returned as discriminated values so the entry page can offer a retry, while genuinely
 * exceptional responses (bad code, network) surface as {@link ApiError} throws.
 */

function publicShopPath(publicShopId: string, suffix = ''): string {
  return `/api/public/shops/${encodeURIComponent(publicShopId)}${suffix}`;
}

/**
 * Resolve a scanned permanent QR. Throws {@link ApiError} on 404 (SHOP_NOT_FOUND) or 400
 * (INVALID_SHOP_CODE) — a missing/garbled code is a hard failure, not a retryable state.
 */
export function resolvePublicShop(
  publicShopId: string,
  signal?: AbortSignal
): Promise<PublicShopResolveResponse> {
  return apiRequest<PublicShopResolveResponse>(publicShopPath(publicShopId), { method: 'GET', signal });
}

export type ConnectPublicShopResult =
  | { kind: 'ok'; session: PublicShopConnectResponse }
  /** Shop has no live/heartbeating dashboard right now (409 SHOP_OFFLINE). */
  | { kind: 'offline' }
  /** Shop is online but has not opened a transfer session yet (409 SHOP_NOT_READY). */
  | { kind: 'not_ready' };

/**
 * Bridge to the shop's current transfer session. Maps the two documented 409 states to
 * return values; re-throws everything else (404 unknown shop, 400 bad code, network).
 */
export async function connectPublicShop(
  publicShopId: string,
  signal?: AbortSignal
): Promise<ConnectPublicShopResult> {
  try {
    const session = await apiRequest<PublicShopConnectResponse>(publicShopPath(publicShopId, '/connect'), {
      method: 'POST',
      signal,
    });
    return { kind: 'ok', session };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      if (err.code === 'SHOP_OFFLINE') return { kind: 'offline' };
      if (err.code === 'SHOP_NOT_READY') return { kind: 'not_ready' };
    }
    throw err;
  }
}
