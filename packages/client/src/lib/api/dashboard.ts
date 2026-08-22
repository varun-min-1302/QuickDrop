/**
 * Dashboard-device + shop-scoped transfer-session API calls (spec §11, §12, §15, §16).
 *
 * These wrap the authenticated owner endpoints that the shop dashboard drives:
 *   - claim/heartbeat/release enforce the ONE ACTIVE DASHBOARD DEVICE PER SHOP policy and
 *     keep the shop "online" so the customer bridge will route to it;
 *   - openShopSession opens the ephemeral transfer session the dashboard JOINs as `shop`,
 *     replacing the legacy anonymous `POST /api/sessions` path WITHOUT touching the WebRTC
 *     transfer architecture.
 *
 * Two outcomes are modelled as return values rather than thrown errors because the UI must
 * react to them specifically: a claim CONFLICT (another device holds the dashboard → show
 * "[Take Over]") and a heartbeat REVOKED (this device was taken over → stop being the
 * dashboard). Every other non-2xx still throws {@link ApiError}. No document bytes are ever
 * sent or stored by these calls.
 */
import type { ShopSummary, CreateSessionResponse, DashboardDeviceSummary } from '@quickdrop/shared';
import { apiRequest, ApiError } from './http.js';

/** The device currently holding a shop's dashboard, as reported by a claim conflict (§11). */
export interface DashboardActiveDevice {
  deviceLabel: string;
  connectedAt: number;
  lastSeenAt: number;
}

/** Result of attempting to claim the dashboard. `conflict` carries the incumbent device. */
export type ClaimDashboardResult =
  | { kind: 'ok'; deviceSessionId: string; shop: ShopSummary }
  | { kind: 'conflict'; activeDevice: DashboardActiveDevice };

/** Result of a heartbeat. `revoked` = this device is no longer the active dashboard. */
export type HeartbeatResult = { kind: 'ok'; lastSeenAt: number } | { kind: 'revoked' };

/** Current dashboard presence for the settings / take-over view (§21). */
export interface DashboardStatusResult {
  active: DashboardDeviceSummary | null;
  online: boolean;
}

function shopPath(publicShopId: string, suffix: string): string {
  return `/api/shops/${encodeURIComponent(publicShopId)}${suffix}`;
}

/** Narrow the 409 conflict body to the fields the take-over prompt needs. */
function readActiveDevice(body: unknown): DashboardActiveDevice | null {
  if (!body || typeof body !== 'object') return null;
  const ad = (body as { activeDevice?: unknown }).activeDevice;
  if (!ad || typeof ad !== 'object') return null;
  const { deviceLabel, connectedAt, lastSeenAt } = ad as Record<string, unknown>;
  if (
    typeof deviceLabel === 'string' &&
    typeof connectedAt === 'number' &&
    typeof lastSeenAt === 'number'
  ) {
    return { deviceLabel, connectedAt, lastSeenAt };
  }
  return null;
}

/**
 * POST /api/shops/:publicShopId/dashboard/claim — become the shop's ONE active dashboard.
 * With `takeOver` the server atomically revokes the incumbent. A 409 DASHBOARD_ALREADY_ACTIVE
 * is returned as a `conflict` result (with the active device) rather than thrown; all other
 * non-2xx statuses throw {@link ApiError}.
 */
export async function claimDashboard(
  publicShopId: string,
  opts: { takeOver?: boolean; deviceLabel?: string } = {},
  signal?: AbortSignal
): Promise<ClaimDashboardResult> {
  const body: { takeOver: boolean; deviceLabel?: string } = { takeOver: opts.takeOver ?? false };
  if (opts.deviceLabel) body.deviceLabel = opts.deviceLabel;
  try {
    const res = await apiRequest<{ deviceSessionId: string; shop: ShopSummary }>(
      shopPath(publicShopId, '/dashboard/claim'),
      { method: 'POST', body, signal }
    );
    return { kind: 'ok', deviceSessionId: res.deviceSessionId, shop: res.shop };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === 'DASHBOARD_ALREADY_ACTIVE') {
      const activeDevice = readActiveDevice(err.body);
      if (activeDevice) return { kind: 'conflict', activeDevice };
    }
    throw err;
  }
}

/**
 * POST /api/shops/:publicShopId/dashboard/heartbeat — refresh presence. A 409 DASHBOARD_REVOKED
 * (this device was taken over elsewhere) is returned as `revoked`; other non-2xx statuses throw.
 */
export async function heartbeatDashboard(
  publicShopId: string,
  deviceSessionId: string,
  signal?: AbortSignal
): Promise<HeartbeatResult> {
  try {
    const res = await apiRequest<{ online: true; lastSeenAt: number }>(
      shopPath(publicShopId, '/dashboard/heartbeat'),
      { method: 'POST', body: { deviceSessionId }, signal }
    );
    return { kind: 'ok', lastSeenAt: res.lastSeenAt };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === 'DASHBOARD_REVOKED') {
      return { kind: 'revoked' };
    }
    throw err;
  }
}

/** POST /api/shops/:publicShopId/dashboard/release — voluntarily give up the dashboard (idempotent). */
export async function releaseDashboard(
  publicShopId: string,
  deviceSessionId: string,
  signal?: AbortSignal
): Promise<void> {
  await apiRequest<{ released: true }>(shopPath(publicShopId, '/dashboard/release'), {
    method: 'POST',
    body: { deviceSessionId },
    signal,
  });
}

/** GET /api/shops/:publicShopId/dashboard — current dashboard presence (§21). */
export function getDashboardStatus(
  publicShopId: string,
  deviceSessionId?: string,
  signal?: AbortSignal
): Promise<DashboardStatusResult> {
  const query = deviceSessionId ? `?deviceSessionId=${encodeURIComponent(deviceSessionId)}` : '';
  return apiRequest<DashboardStatusResult>(shopPath(publicShopId, `/dashboard${query}`), {
    method: 'GET',
    signal,
  });
}

/**
 * POST /api/shops/:publicShopId/sessions — open a shop-scoped transfer session (§16 bridge).
 * Returns the same {@link CreateSessionResponse} the legacy anonymous route did, so the
 * existing WebRTC JOIN-as-shop wiring is unchanged; only the origin of the session moves to
 * the authenticated, shop-linked endpoint. The raw joinToken is returned only to the shop.
 */
export function openShopSession(
  publicShopId: string,
  ttlSeconds?: number,
  signal?: AbortSignal
): Promise<CreateSessionResponse> {
  return apiRequest<CreateSessionResponse>(shopPath(publicShopId, '/sessions'), {
    method: 'POST',
    body: ttlSeconds ? { ttlSeconds } : {},
    signal,
  });
}
