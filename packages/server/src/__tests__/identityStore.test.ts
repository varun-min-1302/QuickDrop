import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { MemoryIdentityStore } from '../identity/memoryIdentityStore.js';
import { SqliteIdentityStore } from '../identity/sqliteIdentityStore.js';
import {
  IIdentityStore,
  UserRecord,
  ShopRecord,
  ShopMembershipRecord,
  DashboardDeviceRecord,
  AuthSessionRecord,
  UniqueConstraintError,
} from '../identity/types.js';

// The two implementations must behave identically. Sqlite runs against an in-memory
// database (no disk, no file), which also proves the native driver + SQL load cleanly.
const implementations: Array<{ name: string; make: () => IIdentityStore }> = [
  { name: 'MemoryIdentityStore', make: () => new MemoryIdentityStore() },
  { name: 'SqliteIdentityStore(:memory:)', make: () => new SqliteIdentityStore(':memory:') },
];

function makeUser(over: Partial<UserRecord> = {}): UserRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    email: `owner-${crypto.randomUUID().slice(0, 8)}@example.com`,
    passwordHash: 'scrypt$16384$8$1$deadbeef$cafebabe',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}
function makeShop(createdBy: string, over: Partial<ShopRecord> = {}): ShopRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    publicShopId: `QD-${crypto.randomUUID().replace(/[^A-Z0-9]/gi, '').slice(0, 6).toUpperCase()}`,
    name: 'Main Campus Xerox',
    createdBy,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}
function makeDevice(shopId: string, userId: string, over: Partial<DashboardDeviceRecord> = {}): DashboardDeviceRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    shopId,
    userId,
    deviceLabel: 'Chrome on Windows',
    userAgent: 'Mozilla/5.0',
    connectedAt: now,
    lastSeenAt: now,
    status: 'ACTIVE',
    ...over,
  };
}

describe.each(implementations)('IIdentityStore contract — $name', ({ make }) => {
  let store: IIdentityStore;

  beforeEach(async () => {
    store = make();
    await store.init();
  });
  afterEach(async () => {
    await store.close();
  });

  describe('users', () => {
    it('creates and reads a user by id and email', async () => {
      const user = makeUser();
      await store.createUser(user);

      expect(await store.getUserById(user.id)).toEqual(user);
      expect(await store.getUserByEmail(user.email)).toEqual(user);
      expect(await store.getUserById('missing')).toBeNull();
      expect(await store.getUserByEmail('nobody@example.com')).toBeNull();
    });

    it('rejects a duplicate email with UniqueConstraintError', async () => {
      const user = makeUser({ email: 'dup@example.com' });
      await store.createUser(user);
      await expect(store.createUser(makeUser({ email: 'dup@example.com' }))).rejects.toBeInstanceOf(
        UniqueConstraintError
      );
    });
  });

  describe('shops + memberships', () => {
    it('creates a shop, resolves by public id, and enforces publicShopId uniqueness', async () => {
      const user = makeUser();
      await store.createUser(user);
      const shop = makeShop(user.id, { publicShopId: 'QD-7F82A9' });
      await store.createShop(shop);

      expect(await store.getShopById(shop.id)).toEqual(shop);
      expect(await store.getShopByPublicId('QD-7F82A9')).toEqual(shop);
      expect(await store.publicShopIdExists('QD-7F82A9')).toBe(true);
      expect(await store.publicShopIdExists('QD-000000')).toBe(false);

      await expect(store.createShop(makeShop(user.id, { publicShopId: 'QD-7F82A9' }))).rejects.toBeInstanceOf(
        UniqueConstraintError
      );
    });

    it('updates the shop name', async () => {
      const user = makeUser();
      await store.createUser(user);
      const shop = makeShop(user.id);
      await store.createShop(shop);

      expect(await store.updateShopName(shop.id, 'Renamed Shop', shop.updatedAt + 1000)).toBe(true);
      const updated = await store.getShopById(shop.id);
      expect(updated?.name).toBe('Renamed Shop');
      expect(await store.updateShopName('missing', 'x', Date.now())).toBe(false);
    });

    it('creates a membership and resolves ownership, rejecting duplicates', async () => {
      const user = makeUser();
      await store.createUser(user);
      const shop = makeShop(user.id);
      await store.createShop(shop);

      const membership: ShopMembershipRecord = {
        id: crypto.randomUUID(),
        shopId: shop.id,
        userId: user.id,
        role: 'OWNER',
        createdAt: Date.now(),
      };
      await store.createMembership(membership);

      expect(await store.getMembership(shop.id, user.id)).toEqual(membership);
      expect(await store.getMembership(shop.id, 'someone-else')).toBeNull();
      expect(await store.getMembershipsForUser(user.id)).toEqual([membership]);

      await expect(
        store.createMembership({ ...membership, id: crypto.randomUUID() })
      ).rejects.toBeInstanceOf(UniqueConstraintError);
    });
  });

  describe('auth sessions', () => {
    it('creates, reads by token hash, touches, and deletes', async () => {
      const user = makeUser();
      await store.createUser(user);
      const now = Date.now();
      const session: AuthSessionRecord = {
        id: crypto.randomUUID(),
        tokenHash: 'hash-abc',
        userId: user.id,
        createdAt: now,
        expiresAt: now + 1000,
        lastSeenAt: now,
      };
      await store.createAuthSession(session);

      expect(await store.getAuthSessionByTokenHash('hash-abc')).toEqual(session);
      await store.touchAuthSession(session.id, now + 500);
      expect((await store.getAuthSessionByTokenHash('hash-abc'))?.lastSeenAt).toBe(now + 500);

      await store.deleteAuthSession(session.id);
      expect(await store.getAuthSessionByTokenHash('hash-abc')).toBeNull();
    });

    it('deletes all sessions for a user (logout everywhere) and prunes expired', async () => {
      const user = makeUser();
      await store.createUser(user);
      const now = Date.now();
      await store.createAuthSession({
        id: crypto.randomUUID(), tokenHash: 'h1', userId: user.id, createdAt: now, expiresAt: now + 10_000, lastSeenAt: now,
      });
      await store.createAuthSession({
        id: crypto.randomUUID(), tokenHash: 'h2', userId: user.id, createdAt: now, expiresAt: now - 1, lastSeenAt: now,
      });

      expect(await store.deleteExpiredAuthSessions(now)).toBe(1);
      expect(await store.getAuthSessionByTokenHash('h2')).toBeNull();
      expect(await store.getAuthSessionByTokenHash('h1')).not.toBeNull();

      await store.deleteAuthSessionsForUser(user.id);
      expect(await store.getAuthSessionByTokenHash('h1')).toBeNull();
    });
  });

  describe('dashboard device sessions (one active per shop + take-over §11)', () => {
    it('claims the first device, blocks a second without take-over, and hands over with take-over', async () => {
      const user = makeUser();
      await store.createUser(user);
      const shop = makeShop(user.id);
      await store.createShop(shop);

      // Laptop A claims — succeeds, becomes the active device.
      const deviceA = makeDevice(shop.id, user.id, { deviceLabel: 'Laptop A' });
      const claimA = await store.claimDashboardDevice(deviceA, false);
      expect(claimA.ok).toBe(true);
      expect((await store.getActiveDashboardDevice(shop.id))?.id).toBe(deviceA.id);

      // Laptop B claims WITHOUT take-over — blocked, told who is active.
      const deviceB = makeDevice(shop.id, user.id, { deviceLabel: 'Laptop B' });
      const claimBlocked = await store.claimDashboardDevice(deviceB, false);
      expect(claimBlocked.ok).toBe(false);
      if (!claimBlocked.ok) {
        expect(claimBlocked.active.deviceLabel).toBe('Laptop A');
      }
      // A is still the only active device.
      expect((await store.getActiveDashboardDevice(shop.id))?.id).toBe(deviceA.id);

      // Laptop B takes over — A is revoked, B becomes active.
      const claimTakeover = await store.claimDashboardDevice(deviceB, true);
      expect(claimTakeover.ok).toBe(true);
      expect((await store.getActiveDashboardDevice(shop.id))?.id).toBe(deviceB.id);
      expect((await store.getDashboardDeviceById(deviceA.id))?.status).toBe('REVOKED');
    });

    it('touches only active devices and revokes on demand', async () => {
      const user = makeUser();
      await store.createUser(user);
      const shop = makeShop(user.id);
      await store.createShop(shop);
      const device = makeDevice(shop.id, user.id);
      await store.claimDashboardDevice(device, false);

      expect(await store.touchDashboardDevice(device.id, Date.now() + 5000)).toBe(true);
      expect(await store.revokeDashboardDevice(device.id)).toBe(true);
      // Once revoked it is neither active nor touchable.
      expect(await store.getActiveDashboardDevice(shop.id)).toBeNull();
      expect(await store.touchDashboardDevice(device.id, Date.now())).toBe(false);
      expect(await store.revokeDashboardDevice(device.id)).toBe(false);
    });
  });
});
