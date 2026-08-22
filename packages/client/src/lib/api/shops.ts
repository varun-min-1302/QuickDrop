/**
 * Owner shop-identity API calls (spec §5, §6). Typed wrappers over {@link apiRequest}.
 * All are ownership-scoped server-side (401/403/404); the client never trusts its own
 * view of which shops exist.
 */
import type { ShopSummary } from '@quickdrop/shared';
import { apiRequest } from './http.js';

/** POST /api/shops — create the permanent shop; caller becomes OWNER. */
export function createShop(name: string, signal?: AbortSignal): Promise<ShopSummary> {
  return apiRequest<ShopSummary>('/api/shops', { method: 'POST', body: { name }, signal });
}

/** GET /api/shops — the shops the signed-in owner belongs to. */
export function listShops(signal?: AbortSignal): Promise<ShopSummary[]> {
  return apiRequest<{ shops: ShopSummary[] }>('/api/shops', { method: 'GET', signal }).then((r) => r.shops);
}

/** GET /api/shops/:id — ownership-scoped read of one shop. */
export function getShop(id: string, signal?: AbortSignal): Promise<ShopSummary> {
  return apiRequest<ShopSummary>(`/api/shops/${encodeURIComponent(id)}`, { method: 'GET', signal });
}

/** PATCH /api/shops/:id — rename a shop the caller owns. */
export function renameShop(id: string, name: string, signal?: AbortSignal): Promise<ShopSummary> {
  return apiRequest<ShopSummary>(`/api/shops/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name },
    signal,
  });
}
