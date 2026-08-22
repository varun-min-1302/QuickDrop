# Shop Identity & Persistence Decision Record

> Status: **accepted** · Decided before implementation, per the production-architecture spec §24
> ("Document the decision before implementation").

QuickDrop was originally an **ephemeral-only** system: the only server-side state was a
temporary *transfer session* (Redis `setex` / in-memory Map with a TTL), and the printed QR
code encoded that session's join token — so the QR died the moment the 15-minute session
expired. This document records the decision to introduce a **permanent shop identity** backed
by a real persistent store, and how it stays strictly separated from the temporary transfer
session and the ephemeral WebRTC connection.

## The five concepts (never merge these)

| # | Concept | Lifetime | Where it lives | Identifier |
|---|---------|----------|----------------|------------|
| 1 | **User auth session** | login → logout / expiry | persistent store (`auth_sessions`) | opaque cookie token (hashed at rest) |
| 2 | **Shop identity** | permanent | persistent store (`shops`) | `publicShopId` (e.g. `QD-7F82A9`) |
| 3 | **Dashboard device session** | while a dashboard tab is the active device | persistent store (`dashboard_device_sessions`) | device session id |
| 4 | **Transfer session** | temporary (15 min TTL) | Redis / in-memory (unchanged) | `sessionId`, `joinToken`, `numericCode` |
| 5 | **WebRTC peer connection** | duration of a P2P link | browser only | `peerId` (ephemeral) / `clientId` (stable customer) |

Invariants (from spec §18/§30):

- **PERMANENT QR ≠ AUTH CREDENTIAL** — the QR carries only `publicShopId`, never a password, hash, token, or key.
- **SHOP IDENTITY ≠ TRANSFER SESSION** — a transfer session expiring must never invalidate the printed QR.
- **AUTH SESSION ≠ TRANSFER SESSION** — owner login is unrelated to the customer transfer session.
- **clientId ≠ peerId**, **SHOP ≠ SHOP BROWSER**, **CUSTOMER ≠ CUSTOMER ACCOUNT**, **DOCUMENT ≠ BACKEND DATA**.

## Storage engine decision — SQLite via `better-sqlite3`

The spec (§24) forbids blindly adding PostgreSQL/Firebase/Supabase and forbids using Redis as
the permanent source of truth for shop ownership. Redis/in-memory here is deliberately
ephemeral (everything is written with a TTL), so it cannot be the system of record for accounts
and ownership.

**Decision: a local SQLite database (`better-sqlite3`) is the permanent source of truth for
User / Shop / ShopMembership / DashboardDeviceSession / AuthSession.**

Why SQLite:

- **Right-sized.** A print shop has one owner and a handful of records; a single-file embedded DB
  is the simplest durable store that gives us real transactions and unique constraints.
- **No new infrastructure.** No server to run, no network dependency, no container — it is a file
  on disk (`./data/quickdrop.db`, configurable via `IDENTITY_DB_PATH`).
- **Transactional & synchronous.** `better-sqlite3` is synchronous and fast, so account creation,
  ownership checks, and the atomic "take-over" (revoke A + activate B) are simple, race-free
  transactions.
- **Preserves the existing ephemeral layer.** Redis / in-memory continues to own the temporary
  transfer session exactly as before. Nothing about the WebRTC / file-transfer path changes.

The store sits behind an interface, `IIdentityStore`, with two implementations:

- `SqliteIdentityStore` — production/dev, backed by `better-sqlite3`.
- `MemoryIdentityStore` — used by the automated test suite so tests never touch disk and stay
  hermetic (mirrors the existing `MemorySessionStore` pattern).

The SQLite driver is imported **lazily** (only when `SqliteIdentityStore` is constructed), so the
test path never loads the native addon.

### Driver note (Node 24)

The target machine runs **Node 24** with no Visual Studio C++ toolchain. `better-sqlite3@13` is
used because it ships a **prebuilt** native binary for the Node 24 ABI, so `npm install` needs no
compiler. (Older lines such as `better-sqlite3@11` had no matching prebuild and tried to compile
from source, which fails without MSVC — avoid pinning below the prebuilt range on this
environment.) Everything is behind `IIdentityStore`, so the driver remains swappable.

### Zero document storage is unchanged (§17)

The persistent DB stores **only** account/shop/membership/device-session/auth-session metadata.
It **must never** store document bytes, chunks, Blobs, or files. Document bytes continue to travel
Phone → Shop over the WebRTC DataChannel and never touch Redis or SQLite.

## Domain model (§3)

```
User                     Shop                         ShopMembership
────                     ────                         ──────────────
id            (uuid)     id             (uuid)        id        (uuid)
email         (unique)   publicShopId   (unique)      shopId    → Shop.id
passwordHash             name                         userId    → User.id
createdAt                createdBy      → User.id      role      (OWNER | ADMIN | STAFF | COUNTER_OPERATOR)
updatedAt                status         (ACTIVE|SUSPENDED)   createdAt
                         createdAt
                         updatedAt

DashboardDeviceSession                    AuthSession (login session, §8)
──────────────────────                    ───────────────────────────────
id            (uuid)                      id            (uuid)
shopId        → Shop.id                   tokenHash     (sha-256 of cookie token, unique)
userId        → User.id                   userId        → User.id
deviceLabel   (UA-derived, non-authoritative)  createdAt
userAgent                                 expiresAt
connectedAt                               lastSeenAt
lastSeenAt
status        (ACTIVE | REVOKED)
```

MVP role is **OWNER** only; the `role` column and a `ROLE` enum keep ADMIN / STAFF /
COUNTER_OPERATOR reserved for later without implementing them now.

### publicShopId

- Format `QD-XXXXXX` (e.g. `QD-7F82A9`), 6 chars from an unambiguous alphabet (no `0/O/1/I`).
- It is a **public reference, not a credential.** Knowing it lets a customer *scan* a shop; it
  grants no dashboard access. All shop-management APIs require the authenticated owner session and
  a verified membership — never a browser-supplied shop id.

## Permanent QR (see [permanent-qr.md](permanent-qr.md))

The printed poster encodes `https://<host>/s/<publicShopId>`. Scanning resolves the shop, checks
whether it currently has an active dashboard device (online), and only then creates a fresh
temporary transfer session and hands off to the existing WebRTC join flow. A 15-minute transfer
session expiring never changes the poster.
