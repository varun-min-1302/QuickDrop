import type { ShopRole, ShopStatus, DashboardDeviceStatus } from '@quickdrop/shared';

/**
 * Internal persistence entities for the PERMANENT shop-identity layer.
 *
 * These are server-only and secret-bearing (e.g. `passwordHash`, auth-session
 * `tokenHash`). They deliberately do NOT live in `@quickdrop/shared`, so a hash or
 * token shape can never leak into the client bundle. Routes map these to the safe
 * DTOs in `@quickdrop/shared` before anything crosses the wire.
 *
 * This layer is the durable source of truth (SQLite). It is strictly separate from
 * the ephemeral transfer-session store (Redis / in-memory) and MUST NEVER store any
 * document bytes (spec §17).
 */

export interface UserRecord {
  id: string;
  /** Normalized (trimmed, lowercased) email. Unique. */
  email: string;
  /** scrypt$N$r$p$saltHex$hashHex — never logged, never returned over the wire. */
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface ShopRecord {
  id: string;
  /** Public, non-secret reference embedded in the QR, e.g. `QD-7F82A9`. Unique. */
  publicShopId: string;
  name: string;
  /** userId of the creating owner. */
  createdBy: string;
  status: ShopStatus;
  createdAt: number;
  updatedAt: number;
}

export interface ShopMembershipRecord {
  id: string;
  shopId: string;
  userId: string;
  role: ShopRole;
  createdAt: number;
}

/**
 * A dashboard "device" — the browser currently authorized to act as the shop
 * dashboard. MVP policy is ONE ACTIVE device per shop (§11/§12). `lastSeenAt` drives
 * online presence (§15); `status` drives take-over/revocation.
 */
export interface DashboardDeviceRecord {
  id: string;
  shopId: string;
  userId: string;
  /** Human-friendly, NON-authoritative label (UA-derived). Never used for auth. */
  deviceLabel: string;
  userAgent: string | null;
  connectedAt: number;
  lastSeenAt: number;
  status: DashboardDeviceStatus;
}

/** Server-side owner login session, addressed by an opaque HttpOnly cookie token. */
export interface AuthSessionRecord {
  id: string;
  /** SHA-256 of the cookie token. The raw token is never persisted. Unique. */
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

/** Thrown by any store when a UNIQUE constraint is violated (duplicate email, etc.). */
export class UniqueConstraintError extends Error {
  constructor(public readonly field: string) {
    super(`Unique constraint violated: ${field}`);
    this.name = 'UniqueConstraintError';
  }
}

/** Result of an atomic dashboard take-over attempt (§11). */
export type ClaimDashboardResult =
  | { ok: true }
  | { ok: false; active: DashboardDeviceRecord };

/**
 * Persistent identity store. Two implementations: `SqliteIdentityStore` (durable,
 * production/dev) and `MemoryIdentityStore` (hermetic, tests). Mirrors the existing
 * `ISessionStore` split.
 */
export interface IIdentityStore {
  init(): Promise<void>;

  // ── Users ──────────────────────────────────────────────────────────────────
  createUser(user: UserRecord): Promise<void>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;

  // ── Shops ──────────────────────────────────────────────────────────────────
  createShop(shop: ShopRecord): Promise<void>;
  getShopById(id: string): Promise<ShopRecord | null>;
  getShopByPublicId(publicShopId: string): Promise<ShopRecord | null>;
  publicShopIdExists(publicShopId: string): Promise<boolean>;
  updateShopName(id: string, name: string, updatedAt: number): Promise<boolean>;

  // ── Memberships ──────────────────────────────────────────────────────────────
  createMembership(membership: ShopMembershipRecord): Promise<void>;
  getMembership(shopId: string, userId: string): Promise<ShopMembershipRecord | null>;
  getMembershipsForUser(userId: string): Promise<ShopMembershipRecord[]>;

  // ── Auth sessions (owner login) ──────────────────────────────────────────────
  createAuthSession(session: AuthSessionRecord): Promise<void>;
  getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  touchAuthSession(id: string, lastSeenAt: number): Promise<void>;
  deleteAuthSession(id: string): Promise<void>;
  deleteAuthSessionsForUser(userId: string): Promise<void>;
  /** Housekeeping: drop sessions whose expiresAt is in the past. Returns count removed. */
  deleteExpiredAuthSessions(now: number): Promise<number>;

  // ── Dashboard device sessions (one active per shop) ──────────────────────────
  getDashboardDeviceById(id: string): Promise<DashboardDeviceRecord | null>;
  getActiveDashboardDevice(shopId: string): Promise<DashboardDeviceRecord | null>;
  touchDashboardDevice(id: string, lastSeenAt: number): Promise<boolean>;
  revokeDashboardDevice(id: string): Promise<boolean>;
  /**
   * Atomically enforce the one-active-device policy: if an ACTIVE device already
   * exists and `takeOver` is false, returns `{ok:false, active}`; otherwise revokes
   * any existing active device(s) and inserts `device`, returning `{ok:true}`.
   */
  claimDashboardDevice(
    device: DashboardDeviceRecord,
    takeOver: boolean
  ): Promise<ClaimDashboardResult>;

  close(): Promise<void>;
}
