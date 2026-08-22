import crypto from 'node:crypto';
import type {
  ShopSummary,
  ShopRole,
  PublicShopResolveResponse,
  DashboardDeviceSummary,
} from '@quickdrop/shared';
import {
  IIdentityStore,
  ShopRecord,
  ShopMembershipRecord,
  DashboardDeviceRecord,
  UniqueConstraintError,
} from '../identity/index.js';
import { generatePublicShopId } from './publicShopId.js';

/**
 * Result of an ownership-scoped shop lookup, modelling the §9 authorization ladder:
 *   not_found  → 404 (shop does not exist)
 *   forbidden  → 403 (authenticated, but the user is not a member of this shop)
 *   ok         → 200 (member; `summary` includes the caller's role)
 */
export type ShopAccess =
  | { kind: 'ok'; summary: ShopSummary }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/** Ownership-scoped result of a publicShopId → shop resolution used by dashboard ops. */
type PublicShopAccess =
  | { kind: 'ok'; shop: ShopRecord; role: ShopRole }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/**
 * Outcome of a dashboard-device claim (§11/§12). `conflict` carries the currently
 * active device so the caller can render the take-over prompt.
 */
export type DashboardClaim =
  | { kind: 'ok'; deviceSessionId: string; summary: ShopSummary }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'conflict'; active: DashboardDeviceRecord };

/** Outcome of a dashboard heartbeat. `revoked` = this device lost the dashboard (taken over). */
export type DashboardHeartbeat =
  | { kind: 'ok'; lastSeenAt: number; online: true }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'revoked' };

/** Outcome of releasing (revoking) a dashboard device — idempotent for the caller's own shop. */
export type DashboardRelease =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/** Outcome of reading the shop's current dashboard presence (§21 settings / take-over UI). */
export type DashboardStatus =
  | { kind: 'ok'; active: DashboardDeviceSummary | null; online: boolean }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/**
 * Shop identity service (spec §3–§6). Owns permanent shop creation (unique
 * `publicShopId` + OWNER membership) and ownership-scoped reads/updates.
 *
 * Never trusts a browser-supplied shop identity: every method authorizes against the
 * persisted membership using the *authenticated* userId passed in by the route.
 */
export class ShopService {
  constructor(
    private readonly store: IIdentityStore,
    private readonly presenceTtlSeconds: number
  ) {}

  /** Create the permanent shop and make the caller its OWNER. */
  async createShop(userId: string, name: string): Promise<ShopSummary> {
    const now = Date.now();

    // Generate + insert, retrying if a concurrent creator grabbed the same id between
    // the existence check and the insert (belt-and-braces around the UNIQUE column).
    let shop: ShopRecord | null = null;
    for (let attempt = 0; attempt < 3 && !shop; attempt++) {
      const publicShopId = await generatePublicShopId((id) => this.store.publicShopIdExists(id));
      const candidate: ShopRecord = {
        id: crypto.randomUUID(),
        publicShopId,
        name,
        createdBy: userId,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.store.createShop(candidate);
        shop = candidate;
      } catch (err) {
        if (err instanceof UniqueConstraintError) continue; // regenerate and retry
        throw err;
      }
    }
    if (!shop) throw new Error('Failed to create shop: could not allocate a unique publicShopId');

    const membership: ShopMembershipRecord = {
      id: crypto.randomUUID(),
      shopId: shop.id,
      userId,
      role: 'OWNER',
      createdAt: now,
    };
    await this.store.createMembership(membership);

    return toShopSummary(shop, 'OWNER');
  }

  /** All shops the user is a member of, each tagged with their role. */
  async listShops(userId: string): Promise<ShopSummary[]> {
    const memberships = await this.store.getMembershipsForUser(userId);
    const summaries: ShopSummary[] = [];
    for (const m of memberships) {
      const shop = await this.store.getShopById(m.shopId);
      if (shop) summaries.push(toShopSummary(shop, m.role));
    }
    return summaries;
  }

  /** Ownership-scoped read of a single shop. */
  async getShopForUser(userId: string, shopId: string): Promise<ShopAccess> {
    const shop = await this.store.getShopById(shopId);
    if (!shop) return { kind: 'not_found' };
    const membership = await this.store.getMembership(shopId, userId);
    if (!membership) return { kind: 'forbidden' };
    return { kind: 'ok', summary: toShopSummary(shop, membership.role) };
  }

  /**
   * Ownership-scoped read keyed by the public shop code (used by the shop-scoped
   * transfer-session bridge, §16). Same §9 ladder as {@link getShopForUser}; the
   * returned summary's `id` is the internal shopId needed to link the session.
   */
  async getShopForUserByPublicId(userId: string, publicShopId: string): Promise<ShopAccess> {
    const auth = await this.authorizeByPublicId(userId, publicShopId);
    if (auth.kind === 'not_found') return { kind: 'not_found' };
    if (auth.kind === 'forbidden') return { kind: 'forbidden' };
    return { kind: 'ok', summary: toShopSummary(auth.shop, auth.role) };
  }

  /**
   * Internal context for the customer bridge (§16): resolve a public shop code to its
   * internal id, name, and current online state. Unauthenticated-safe (returns no owner
   * data). Null when the shop does not exist or is not ACTIVE.
   */
  async getPublicShopConnectContext(
    publicShopId: string
  ): Promise<{ shopId: string; name: string; online: boolean } | null> {
    const shop = await this.store.getShopByPublicId(publicShopId);
    if (!shop || shop.status !== 'ACTIVE') return null;
    return { shopId: shop.id, name: shop.name, online: await this.isShopOnline(shop.id) };
  }

  /** Rename a shop the user owns/administers. Preserves the authorization ladder. */
  async renameShop(userId: string, shopId: string, name: string): Promise<ShopAccess> {
    const access = await this.getShopForUser(userId, shopId);
    if (access.kind !== 'ok') return access;
    const now = Date.now();
    await this.store.updateShopName(shopId, name, now);
    return { kind: 'ok', summary: { ...access.summary, name, updatedAt: now } };
  }

  /**
   * Customer-facing resolution of a scanned permanent QR (spec §4, §14). Returns only
   * the minimal public view — shop name + whether it is currently online — or null if
   * no such active shop exists. Never requires authentication and never leaks owner
   * identity, membership, or private shop data.
   */
  async resolvePublicShop(publicShopId: string): Promise<PublicShopResolveResponse | null> {
    const shop = await this.store.getShopByPublicId(publicShopId);
    if (!shop || shop.status !== 'ACTIVE') return null;
    return {
      publicShopId: shop.publicShopId,
      name: shop.name,
      online: await this.isShopOnline(shop.id),
    };
  }

  /**
   * A shop is "online" when it has an ACTIVE dashboard device whose heartbeat is
   * within the presence TTL (§15). Until a device claims the dashboard (Phase G) this
   * is simply false — which is the correct, forward-compatible answer.
   */
  async isShopOnline(shopId: string): Promise<boolean> {
    const device = await this.store.getActiveDashboardDevice(shopId);
    if (!device) return false;
    return this.isFresh(device.lastSeenAt);
  }

  /**
   * Claim the ONE active dashboard device for a shop (spec §11/§12). Authorized by
   * membership. If another device already holds it and `takeOver` is false, returns
   * `conflict` with the active device so the caller can prompt "[Take Over]". With
   * `takeOver` true, the store atomically revokes the incumbent and installs this one.
   */
  async claimDashboard(
    userId: string,
    publicShopId: string,
    opts: { takeOver: boolean; deviceLabel?: string; userAgent?: string | null }
  ): Promise<DashboardClaim> {
    const auth = await this.authorizeByPublicId(userId, publicShopId);
    if (auth.kind !== 'ok') return auth;

    const now = Date.now();
    const device: DashboardDeviceRecord = {
      id: crypto.randomUUID(),
      shopId: auth.shop.id,
      userId,
      deviceLabel: normalizeDeviceLabel(opts.deviceLabel, opts.userAgent),
      userAgent: opts.userAgent ?? null,
      connectedAt: now,
      lastSeenAt: now,
      status: 'ACTIVE',
    };

    const result = await this.store.claimDashboardDevice(device, opts.takeOver);
    if (!result.ok) return { kind: 'conflict', active: result.active };
    return { kind: 'ok', deviceSessionId: device.id, summary: toShopSummary(auth.shop, auth.role) };
  }

  /**
   * Refresh a dashboard device's presence (spec §15). Returns `revoked` if this
   * deviceSessionId is no longer the shop's active device — i.e. it was taken over —
   * so the client can stop acting as the dashboard.
   */
  async heartbeatDashboard(
    userId: string,
    publicShopId: string,
    deviceSessionId: string
  ): Promise<DashboardHeartbeat> {
    const auth = await this.authorizeByPublicId(userId, publicShopId);
    if (auth.kind !== 'ok') return auth;

    const device = await this.store.getDashboardDeviceById(deviceSessionId);
    if (!device || device.shopId !== auth.shop.id || device.status !== 'ACTIVE') {
      return { kind: 'revoked' };
    }
    const now = Date.now();
    await this.store.touchDashboardDevice(deviceSessionId, now);
    return { kind: 'ok', lastSeenAt: now, online: true };
  }

  /**
   * Explicitly give up the dashboard (owner logs out / closes the tab). Idempotent:
   * revokes only if the device belongs to this shop; unknown ids are a no-op success.
   */
  async releaseDashboard(
    userId: string,
    publicShopId: string,
    deviceSessionId: string
  ): Promise<DashboardRelease> {
    const auth = await this.authorizeByPublicId(userId, publicShopId);
    if (auth.kind !== 'ok') return auth;

    const device = await this.store.getDashboardDeviceById(deviceSessionId);
    if (device && device.shopId === auth.shop.id) {
      await this.store.revokeDashboardDevice(deviceSessionId);
    }
    return { kind: 'ok' };
  }

  /**
   * Read the shop's current dashboard presence for the settings / take-over view
   * (§21). `current` marks the caller's own device when it passes its deviceSessionId.
   */
  async getDashboardStatus(
    userId: string,
    publicShopId: string,
    currentDeviceSessionId?: string
  ): Promise<DashboardStatus> {
    const auth = await this.authorizeByPublicId(userId, publicShopId);
    if (auth.kind !== 'ok') return auth;

    const active = await this.store.getActiveDashboardDevice(auth.shop.id);
    if (!active) return { kind: 'ok', active: null, online: false };

    const summary: DashboardDeviceSummary = {
      id: active.id,
      deviceLabel: active.deviceLabel,
      connectedAt: active.connectedAt,
      lastSeenAt: active.lastSeenAt,
      status: active.status,
      current: currentDeviceSessionId ? active.id === currentDeviceSessionId : false,
    };
    return { kind: 'ok', active: summary, online: this.isFresh(active.lastSeenAt) };
  }

  /** True when a heartbeat timestamp is within the presence TTL window (§15). */
  private isFresh(lastSeenAt: number): boolean {
    return Date.now() - lastSeenAt <= this.presenceTtlSeconds * 1000;
  }

  /**
   * Resolve a publicShopId to a shop and authorize the caller by membership.
   * Non-ACTIVE shops are treated as not_found for live dashboard operations. Never
   * trusts the browser: authorization is against the persisted membership only.
   */
  private async authorizeByPublicId(userId: string, publicShopId: string): Promise<PublicShopAccess> {
    const shop = await this.store.getShopByPublicId(publicShopId);
    if (!shop || shop.status !== 'ACTIVE') return { kind: 'not_found' };
    const membership = await this.store.getMembership(shop.id, userId);
    if (!membership) return { kind: 'forbidden' };
    return { kind: 'ok', shop, role: membership.role };
  }
}

/** Map an internal shop record + the caller's role to the safe owner-facing DTO. */
export function toShopSummary(shop: ShopRecord, role: ShopRole): ShopSummary {
  return {
    id: shop.id,
    publicShopId: shop.publicShopId,
    name: shop.name,
    status: shop.status,
    role,
    createdAt: shop.createdAt,
    updatedAt: shop.updatedAt,
  };
}

/**
 * Produce a human-friendly device label. Prefers an explicit client-supplied label;
 * otherwise derives a best-effort "Browser on OS" from the User-Agent. The label is
 * purely cosmetic (shown in the take-over prompt) and is NEVER used for authorization.
 */
export function normalizeDeviceLabel(
  label: string | undefined,
  userAgent: string | null | undefined
): string {
  const trimmed = label?.trim();
  if (trimmed) return trimmed.slice(0, 80);
  return deriveDeviceLabel(userAgent);
}

function deriveDeviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Dashboard device';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Macintosh|Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iOS/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return 'Dashboard device';
}
