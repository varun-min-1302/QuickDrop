import {
  IIdentityStore,
  UserRecord,
  ShopRecord,
  ShopMembershipRecord,
  DashboardDeviceRecord,
  AuthSessionRecord,
  ClaimDashboardResult,
  UniqueConstraintError,
} from './types.js';

/**
 * In-memory identity store used by the automated test suite (and as a no-disk dev
 * fallback). Node runs one request at a time per process and none of these methods
 * await mid-operation, so check-then-act sequences (e.g. take-over) are atomic.
 *
 * Mirrors the existing `MemorySessionStore` pattern.
 */
export class MemoryIdentityStore implements IIdentityStore {
  private users = new Map<string, UserRecord>(); // id -> user
  private usersByEmail = new Map<string, string>(); // email -> id
  private shops = new Map<string, ShopRecord>(); // id -> shop
  private shopsByPublicId = new Map<string, string>(); // publicShopId -> id
  private memberships = new Map<string, ShopMembershipRecord>(); // id -> membership
  private authSessions = new Map<string, AuthSessionRecord>(); // id -> session
  private authSessionsByTokenHash = new Map<string, string>(); // tokenHash -> id
  private dashboardDevices = new Map<string, DashboardDeviceRecord>(); // id -> device

  async init(): Promise<void> {
    /* nothing to do */
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  async createUser(user: UserRecord): Promise<void> {
    if (this.usersByEmail.has(user.email)) throw new UniqueConstraintError('email');
    this.users.set(user.id, { ...user });
    this.usersByEmail.set(user.email, user.id);
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const id = this.usersByEmail.get(email);
    if (!id) return null;
    return this.getUserById(id);
  }

  // ── Shops ──────────────────────────────────────────────────────────────────
  async createShop(shop: ShopRecord): Promise<void> {
    if (this.shopsByPublicId.has(shop.publicShopId)) throw new UniqueConstraintError('publicShopId');
    this.shops.set(shop.id, { ...shop });
    this.shopsByPublicId.set(shop.publicShopId, shop.id);
  }

  async getShopById(id: string): Promise<ShopRecord | null> {
    const s = this.shops.get(id);
    return s ? { ...s } : null;
  }

  async getShopByPublicId(publicShopId: string): Promise<ShopRecord | null> {
    const id = this.shopsByPublicId.get(publicShopId);
    if (!id) return null;
    return this.getShopById(id);
  }

  async publicShopIdExists(publicShopId: string): Promise<boolean> {
    return this.shopsByPublicId.has(publicShopId);
  }

  async updateShopName(id: string, name: string, updatedAt: number): Promise<boolean> {
    const s = this.shops.get(id);
    if (!s) return false;
    s.name = name;
    s.updatedAt = updatedAt;
    return true;
  }

  // ── Memberships ──────────────────────────────────────────────────────────────
  async createMembership(membership: ShopMembershipRecord): Promise<void> {
    for (const m of this.memberships.values()) {
      if (m.shopId === membership.shopId && m.userId === membership.userId) {
        throw new UniqueConstraintError('shopId+userId');
      }
    }
    this.memberships.set(membership.id, { ...membership });
  }

  async getMembership(shopId: string, userId: string): Promise<ShopMembershipRecord | null> {
    for (const m of this.memberships.values()) {
      if (m.shopId === shopId && m.userId === userId) return { ...m };
    }
    return null;
  }

  async getMembershipsForUser(userId: string): Promise<ShopMembershipRecord[]> {
    const out: ShopMembershipRecord[] = [];
    for (const m of this.memberships.values()) {
      if (m.userId === userId) out.push({ ...m });
    }
    return out;
  }

  // ── Auth sessions ──────────────────────────────────────────────────────────
  async createAuthSession(session: AuthSessionRecord): Promise<void> {
    if (this.authSessionsByTokenHash.has(session.tokenHash)) {
      throw new UniqueConstraintError('tokenHash');
    }
    this.authSessions.set(session.id, { ...session });
    this.authSessionsByTokenHash.set(session.tokenHash, session.id);
  }

  async getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    const id = this.authSessionsByTokenHash.get(tokenHash);
    if (!id) return null;
    const s = this.authSessions.get(id);
    return s ? { ...s } : null;
  }

  async touchAuthSession(id: string, lastSeenAt: number): Promise<void> {
    const s = this.authSessions.get(id);
    if (s) s.lastSeenAt = lastSeenAt;
  }

  async deleteAuthSession(id: string): Promise<void> {
    const s = this.authSessions.get(id);
    if (!s) return;
    this.authSessions.delete(id);
    this.authSessionsByTokenHash.delete(s.tokenHash);
  }

  async deleteAuthSessionsForUser(userId: string): Promise<void> {
    for (const [id, s] of this.authSessions.entries()) {
      if (s.userId === userId) {
        this.authSessions.delete(id);
        this.authSessionsByTokenHash.delete(s.tokenHash);
      }
    }
  }

  async deleteExpiredAuthSessions(now: number): Promise<number> {
    let n = 0;
    for (const [id, s] of this.authSessions.entries()) {
      if (s.expiresAt <= now) {
        this.authSessions.delete(id);
        this.authSessionsByTokenHash.delete(s.tokenHash);
        n++;
      }
    }
    return n;
  }

  // ── Dashboard device sessions ────────────────────────────────────────────────
  async getDashboardDeviceById(id: string): Promise<DashboardDeviceRecord | null> {
    const d = this.dashboardDevices.get(id);
    return d ? { ...d } : null;
  }

  async getActiveDashboardDevice(shopId: string): Promise<DashboardDeviceRecord | null> {
    for (const d of this.dashboardDevices.values()) {
      if (d.shopId === shopId && d.status === 'ACTIVE') return { ...d };
    }
    return null;
  }

  async touchDashboardDevice(id: string, lastSeenAt: number): Promise<boolean> {
    const d = this.dashboardDevices.get(id);
    if (!d || d.status !== 'ACTIVE') return false;
    d.lastSeenAt = lastSeenAt;
    return true;
  }

  async revokeDashboardDevice(id: string): Promise<boolean> {
    const d = this.dashboardDevices.get(id);
    if (!d || d.status === 'REVOKED') return false;
    d.status = 'REVOKED';
    return true;
  }

  async claimDashboardDevice(
    device: DashboardDeviceRecord,
    takeOver: boolean
  ): Promise<ClaimDashboardResult> {
    const active = await this.getActiveDashboardDevice(device.shopId);
    if (active && !takeOver) {
      return { ok: false, active };
    }
    if (active) {
      const existing = this.dashboardDevices.get(active.id);
      if (existing) existing.status = 'REVOKED';
    }
    this.dashboardDevices.set(device.id, { ...device });
    return { ok: true };
  }

  async close(): Promise<void> {
    this.users.clear();
    this.usersByEmail.clear();
    this.shops.clear();
    this.shopsByPublicId.clear();
    this.memberships.clear();
    this.authSessions.clear();
    this.authSessionsByTokenHash.clear();
    this.dashboardDevices.clear();
  }
}
