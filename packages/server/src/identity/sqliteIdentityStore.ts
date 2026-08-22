import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
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
import type { ShopRole, ShopStatus, DashboardDeviceStatus } from '@quickdrop/shared';

/**
 * Durable identity store backed by SQLite (`better-sqlite3`). This is the permanent
 * source of truth for users, shops, memberships, dashboard-device sessions, and
 * owner auth sessions.
 *
 * It stores account/shop metadata ONLY — never document bytes (spec §17). The
 * ephemeral transfer-session store (Redis / in-memory) is untouched by this class.
 *
 * `better-sqlite3` is synchronous, so check-then-act operations wrapped in
 * `db.transaction(...)` are atomic (used for the dashboard take-over, §11).
 */
export class SqliteIdentityStore implements IIdentityStore {
  private db: Database.Database;
  private initialized = false;

  constructor(dbPath: string) {
    // `:memory:` is supported for ad-hoc use; file paths get their directory created.
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    this.initialized = true;
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  async createUser(user: UserRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, email, password_hash, created_at, updated_at)
           VALUES (@id, @email, @passwordHash, @createdAt, @updatedAt)`
        )
        .run(user);
    } catch (err) {
      throw mapUniqueError(err, 'email');
    }
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as
      | UserRow
      | undefined;
    return row ? rowToUser(row) : null;
  }

  // ── Shops ──────────────────────────────────────────────────────────────────
  async createShop(shop: ShopRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO shops (id, public_shop_id, name, created_by, status, created_at, updated_at)
           VALUES (@id, @publicShopId, @name, @createdBy, @status, @createdAt, @updatedAt)`
        )
        .run(shop);
    } catch (err) {
      throw mapUniqueError(err, 'publicShopId');
    }
  }

  async getShopById(id: string): Promise<ShopRecord | null> {
    const row = this.db.prepare(`SELECT * FROM shops WHERE id = ?`).get(id) as ShopRow | undefined;
    return row ? rowToShop(row) : null;
  }

  async getShopByPublicId(publicShopId: string): Promise<ShopRecord | null> {
    const row = this.db.prepare(`SELECT * FROM shops WHERE public_shop_id = ?`).get(publicShopId) as
      | ShopRow
      | undefined;
    return row ? rowToShop(row) : null;
  }

  async publicShopIdExists(publicShopId: string): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT 1 FROM shops WHERE public_shop_id = ?`)
      .get(publicShopId) as { 1: number } | undefined;
    return !!row;
  }

  async updateShopName(id: string, name: string, updatedAt: number): Promise<boolean> {
    const info = this.db
      .prepare(`UPDATE shops SET name = ?, updated_at = ? WHERE id = ?`)
      .run(name, updatedAt, id);
    return info.changes > 0;
  }

  // ── Memberships ──────────────────────────────────────────────────────────────
  async createMembership(m: ShopMembershipRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO shop_memberships (id, shop_id, user_id, role, created_at)
           VALUES (@id, @shopId, @userId, @role, @createdAt)`
        )
        .run(m);
    } catch (err) {
      throw mapUniqueError(err, 'shopId+userId');
    }
  }

  async getMembership(shopId: string, userId: string): Promise<ShopMembershipRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM shop_memberships WHERE shop_id = ? AND user_id = ?`)
      .get(shopId, userId) as MembershipRow | undefined;
    return row ? rowToMembership(row) : null;
  }

  async getMembershipsForUser(userId: string): Promise<ShopMembershipRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM shop_memberships WHERE user_id = ?`)
      .all(userId) as MembershipRow[];
    return rows.map(rowToMembership);
  }

  // ── Auth sessions ──────────────────────────────────────────────────────────
  async createAuthSession(s: AuthSessionRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO auth_sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at)
           VALUES (@id, @tokenHash, @userId, @createdAt, @expiresAt, @lastSeenAt)`
        )
        .run(s);
    } catch (err) {
      throw mapUniqueError(err, 'tokenHash');
    }
  }

  async getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`)
      .get(tokenHash) as AuthSessionRow | undefined;
    return row ? rowToAuthSession(row) : null;
  }

  async touchAuthSession(id: string, lastSeenAt: number): Promise<void> {
    this.db.prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`).run(lastSeenAt, id);
  }

  async deleteAuthSession(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).run(id);
  }

  async deleteAuthSessionsForUser(userId: string): Promise<void> {
    this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
  }

  async deleteExpiredAuthSessions(now: number): Promise<number> {
    const info = this.db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(now);
    return info.changes;
  }

  // ── Dashboard device sessions ────────────────────────────────────────────────
  async getDashboardDeviceById(id: string): Promise<DashboardDeviceRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM dashboard_device_sessions WHERE id = ?`)
      .get(id) as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  async getActiveDashboardDevice(shopId: string): Promise<DashboardDeviceRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM dashboard_device_sessions
         WHERE shop_id = ? AND status = 'ACTIVE'
         ORDER BY connected_at DESC LIMIT 1`
      )
      .get(shopId) as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  async touchDashboardDevice(id: string, lastSeenAt: number): Promise<boolean> {
    const info = this.db
      .prepare(
        `UPDATE dashboard_device_sessions SET last_seen_at = ? WHERE id = ? AND status = 'ACTIVE'`
      )
      .run(lastSeenAt, id);
    return info.changes > 0;
  }

  async revokeDashboardDevice(id: string): Promise<boolean> {
    const info = this.db
      .prepare(`UPDATE dashboard_device_sessions SET status = 'REVOKED' WHERE id = ? AND status = 'ACTIVE'`)
      .run(id);
    return info.changes > 0;
  }

  async claimDashboardDevice(
    device: DashboardDeviceRecord,
    takeOver: boolean
  ): Promise<ClaimDashboardResult> {
    const txn = this.db.transaction((): ClaimDashboardResult => {
      const activeRow = this.db
        .prepare(
          `SELECT * FROM dashboard_device_sessions
           WHERE shop_id = ? AND status = 'ACTIVE'
           ORDER BY connected_at DESC LIMIT 1`
        )
        .get(device.shopId) as DeviceRow | undefined;

      if (activeRow && !takeOver) {
        return { ok: false, active: rowToDevice(activeRow) };
      }
      if (activeRow) {
        this.db
          .prepare(`UPDATE dashboard_device_sessions SET status = 'REVOKED' WHERE shop_id = ? AND status = 'ACTIVE'`)
          .run(device.shopId);
      }
      this.db
        .prepare(
          `INSERT INTO dashboard_device_sessions
             (id, shop_id, user_id, device_label, user_agent, connected_at, last_seen_at, status)
           VALUES (@id, @shopId, @userId, @deviceLabel, @userAgent, @connectedAt, @lastSeenAt, @status)`
        )
        .run(device);
      return { ok: true };
    });
    return txn();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ── SQL schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  public_shop_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_memberships (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (shop_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON shop_memberships(user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS dashboard_device_sessions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  user_agent TEXT,
  connected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_shop_status ON dashboard_device_sessions(shop_id, status);
`;

// ── Row types + mappers (snake_case DB ↔ camelCase records) ──────────────────────

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
}
interface ShopRow {
  id: string;
  public_shop_id: string;
  name: string;
  created_by: string;
  status: string;
  created_at: number;
  updated_at: number;
}
interface MembershipRow {
  id: string;
  shop_id: string;
  user_id: string;
  role: string;
  created_at: number;
}
interface AuthSessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}
interface DeviceRow {
  id: string;
  shop_id: string;
  user_id: string;
  device_label: string;
  user_agent: string | null;
  connected_at: number;
  last_seen_at: number;
  status: string;
}

function rowToUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToShop(r: ShopRow): ShopRecord {
  return {
    id: r.id,
    publicShopId: r.public_shop_id,
    name: r.name,
    createdBy: r.created_by,
    status: r.status as ShopStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToMembership(r: MembershipRow): ShopMembershipRecord {
  return {
    id: r.id,
    shopId: r.shop_id,
    userId: r.user_id,
    role: r.role as ShopRole,
    createdAt: r.created_at,
  };
}
function rowToAuthSession(r: AuthSessionRow): AuthSessionRecord {
  return {
    id: r.id,
    tokenHash: r.token_hash,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
  };
}
function rowToDevice(r: DeviceRow): DashboardDeviceRecord {
  return {
    id: r.id,
    shopId: r.shop_id,
    userId: r.user_id,
    deviceLabel: r.device_label,
    userAgent: r.user_agent,
    connectedAt: r.connected_at,
    lastSeenAt: r.last_seen_at,
    status: r.status as DashboardDeviceStatus,
  };
}

/** Translate a better-sqlite3 UNIQUE/PK violation into our typed error. */
function mapUniqueError(err: unknown, field: string): unknown {
  const code = (err as { code?: string })?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return new UniqueConstraintError(field);
  }
  return err;
}
