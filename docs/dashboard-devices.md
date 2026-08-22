# Dashboard Devices & Presence

Status: **implemented (Phase G)** · Spec §11, §12, §15, §21 · Related: [shop-identity](./shop-identity.md), [permanent-qr](./permanent-qr.md), [auth-security](./auth-security.md)

## What a "dashboard device" is

A **dashboard device** is the one browser currently authorized to act as a shop's
counter dashboard — the screen that shows the live QR, incoming customers, and the
transfer queue. It is a distinct concept from the three other identities in the system:

| Concept | Lifetime | Stored in | Auth |
| --- | --- | --- | --- |
| **Owner auth session** (`qd_auth`) | ~30 days, revocable | SQLite (`AuthSessionRecord`) | signed HttpOnly cookie |
| **Dashboard device** | live while heartbeating | SQLite (`DashboardDeviceRecord`) | owner session + membership |
| Transfer session | 15 min | session store (Redis/mem) | joinToken / numericCode |
| WebRTC P2P | per connection | nowhere (ephemeral) | signaled out-of-band |

A dashboard device does **not** replace the owner login — claiming one *requires* a
valid owner session and shop membership. It is a presence/lease record layered on top.

## Policy: ONE ACTIVE DEVICE PER SHOP (§11/§12)

At most one dashboard device may be `ACTIVE` for a shop at a time. This prevents two
counters from fighting over the same QR/queue. When a second device wants in, the owner
must explicitly **take over**, which atomically revokes the incumbent.

The atomicity lives in the store: `claimDashboardDevice(device, takeOver)` checks for an
existing active device and either refuses (`takeOver` false) or revokes-then-inserts
(`takeOver` true) in a single, non-interleaved operation. Node runs one request at a
time per process and the memory store never awaits mid-operation; the SQLite store does
the same inside a transaction — so the "one active" invariant cannot be raced.

## Endpoints

All are mounted under `/api`, require `requireAuth`, and authorize by **membership** on
the shop resolved from `:publicShopId`. The `publicShopId` is only a lookup key — never
a credential (see [permanent-qr](./permanent-qr.md)). Authorization ladder is the usual
§9: `401` not signed in · `403` signed in but not a member · `404` no such active shop.

### POST /api/shops/:publicShopId/dashboard/claim

Body: `{ takeOver?: boolean = false, deviceLabel?: string }`.

- `200 { deviceSessionId, shop }` — this device is now the active dashboard. Keep
  `deviceSessionId` in memory; it identifies the device to the heartbeat/release calls.
- `409 { error: "DASHBOARD_ALREADY_ACTIVE", message, activeDevice }` — another device
  holds it and `takeOver` was false. `activeDevice` carries `{ deviceLabel, connectedAt,
  lastSeenAt }` so the UI can say *"Front Counter has been active since 9:02 — take
  over?"*. Re-issue the same call with `takeOver: true` to seize it.

`deviceLabel` is cosmetic and **non-authoritative** — used only in the take-over prompt.
If omitted, the server derives a best-effort `"Chrome on Windows"` from the User-Agent.

### POST /api/shops/:publicShopId/dashboard/heartbeat

Body: `{ deviceSessionId }`. The dashboard calls this on an interval (< presence TTL).

- `200 { online: true, lastSeenAt }` — presence refreshed.
- `409 { error: "DASHBOARD_REVOKED", message }` — this `deviceSessionId` is no longer
  the shop's active device (it was taken over, or released). The client must stop acting
  as the dashboard and show the take-over/re-claim screen (Phase H).

### POST /api/shops/:publicShopId/dashboard/release

Body: `{ deviceSessionId }`. Voluntarily give up the dashboard (owner logs out / closes
the tab — ideally via `navigator.sendBeacon`). `200 { released: true }`. Idempotent: an
unknown or already-revoked id for this shop is still a success.

### GET /api/shops/:publicShopId/dashboard

Optional query `?deviceSessionId=...`. Returns `{ active, online }` for the settings /
take-over view (§21). `active` is the `DashboardDeviceSummary` of the current device (or
`null`), and `current: true` marks it when the query id matches the caller's own device.

## Presence & the `online` flag (§15)

Presence is **heartbeat-based**, not connection-based, so it survives brief network
blips and works identically behind the Redis or in-memory session store.

- A shop is **online** iff it has an `ACTIVE` dashboard device whose `lastSeenAt` is
  within `DASHBOARD_PRESENCE_TTL_SECONDS` (default 60s).
- `ShopService.isShopOnline()` powers the customer-facing `online` in the public resolve
  (see [permanent-qr](./permanent-qr.md)); `getDashboardStatus()` powers the owner view.
- A device can be `ACTIVE` but **stale** (row exists, heartbeat lapsed) → treated as
  offline. This is deliberate: a laptop that crashed without releasing simply ages out
  of "online" without needing a server-side reaper. (A future housekeeping job may
  revoke long-stale devices, mirroring `deleteExpiredAuthSessions`.)

The heartbeat interval the client picks must be comfortably under the TTL (e.g. 20–30s
for a 60s TTL) so one dropped beat doesn't flap the shop offline.

## Security invariants

- Claiming/heartbeating/releasing a dashboard **always** requires a valid owner session
  and shop membership — the `deviceSessionId` is not a standalone credential, and even
  possessing it does nothing without the `qd_auth` cookie.
- `deviceSessionId` is a random UUID (unguessable) and only ever names *which* device
  within an already-authorized, membership-scoped request.
- Take-over is member-wide by design (the owner on a new laptop can seize their own
  dashboard); the revoked device learns it lost the lease on its next heartbeat.
- No document bytes, tokens, or password material are involved anywhere in this layer.
