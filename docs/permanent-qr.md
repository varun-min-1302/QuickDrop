# Permanent Shop QR

Status: **resolve endpoint implemented (Phase E)** · **bridge implemented (Phase F)** · **shop-role ownership tightened (Phase I)** · Spec §4, §14, §16 · Related: [shop-identity](./shop-identity.md), [dashboard-devices](./dashboard-devices.md)

## The core problem this solves

The **old** QR encoded an ephemeral transfer token:

```
https://app.example/#<joinToken>          ← dies when the 15-min session expires
```

Reprinting the QR every 15 minutes is unusable for a real shop. The **permanent** QR
encodes only the shop's stable public identity:

```
https://app.example/s/QD-7F82A9           ← never changes; print once, laminate it
```

`QD-7F82A9` is the `publicShopId` (see [shop-identity](./shop-identity.md)). It is a
**public reference, not a credential** and not a transfer token: it grants no
dashboard/owner access, and by itself transfers nothing. The transfer session it
eventually routes to is created, expires, and rotates completely independently — the
QR outlives any number of sessions.

## What may and may not go in the QR

| Allowed in QR | NEVER in QR |
| --- | --- |
| `publicShopId` (the only shop reference) | password / password hash |
| The app origin | auth session token / cookie |
| | transfer `joinToken` or its hash |
| | `numericCode`, `sessionId` |
| | any private key / secret |

The QR is the single stable artifact a shop prints. Everything ephemeral is resolved
at scan time, server-side.

## Resolve endpoint (implemented — Phase E)

`GET /api/public/shops/:publicShopId` — **unauthenticated**, customer-facing.

- Validates the code against `PublicShopIdSchema` (trims, upper-cases, regex). Bad
  format → `400 INVALID_SHOP_CODE`.
- Unknown / suspended shop → `404 SHOP_NOT_FOUND`.
- Otherwise `200` with the **minimal** public view:

  ```json
  { "publicShopId": "QD-7F82A9", "name": "Corner Copy", "online": true }
  ```

`online` is computed from dashboard presence: the shop has an `ACTIVE` dashboard
device whose heartbeat is within `DASHBOARD_PRESENCE_TTL_SECONDS` (§15, Phase G).
Until a dashboard claims presence, `online` is `false` — the correct answer, since
there is nothing for a customer to connect to yet.

The response deliberately excludes owner identity, membership, internal ids, and
session data — a scanned QR reveals only "which shop + is it open right now".

## Client route (client phase)

The path `/s/:publicShopId` will be a client route that:

1. calls the resolve endpoint,
2. shows the shop name and an online/offline state,
3. when online, offers "Connect" which triggers the bridge (below).

The customer never sees or handles a transfer token.

## Bridge design decision: permanent QR → temporary transfer session (Phase F)

> Recorded before implementation per the project constraint, then reconciled with the
> shipped code. This section is the decision **and** how it was built.

### Constraints that shape the design

- The existing transfer architecture must not be rewritten. The shop still **creates**
  transfer sessions; sessions are still ephemeral (15 min), still stored only as
  metadata (tokenHash, numericCode — **never** document bytes), and multi-customer
  join (one shop session, many customers, ≤ 50) must keep working.
- The server stores only the **hash** of the `joinToken`, never the raw token. So the
  server *cannot* hand a raw `joinToken` to a customer — that path is closed by design.
- `publicShopId` must not become a way to reach a shop that is closed, nor a dashboard
  credential.

### Chosen approach — customer connects **by `publicShopId`**, server routes to the current session

Rather than embedding or vending a transfer token, the customer connects using the
`publicShopId` itself, and the **server** maps it to the shop's current active transfer
session, handing back that session's **`numericCode`** (an existing customer-join
credential — never the raw `joinToken`):

1. **Shop side (dashboard online).** When the owner opens the dashboard it (a) claims
   the one active dashboard device (§11, Phase G) and (b) opens a shop-scoped transfer
   session via **`POST /api/shops/:publicShopId/sessions`** (authenticated; membership
   checked with the §9 ladder). Session minting is factored into a shared
   `createTransferSession` helper so this route and the legacy anonymous
   `POST /api/sessions` mint identically; the shop-scoped call additionally records the
   owning `shopId` on the session metadata and writes an **ephemeral**
   `shopId → current sessionId` pointer into the *session* store (it lives and dies with
   the session — it is not permanent shop state, so it does **not** go in SQLite). The
   shop keeps the raw `joinToken` from this response to JOIN signaling as `shop`.
2. **Customer side.** **`POST /api/public/shops/:publicShopId/connect`** (unauthenticated)
   resolves `publicShopId → shopId → current sessionId`, requires the shop to be
   **online**, and returns `{ publicShopId, name, sessionId, numericCode, expiresAt }`.
   The customer then JOINs through the **existing** signaling path using that
   `numericCode`. The signaling `JOIN` schema was relaxed additively so `token` is
   optional and a customer may present `numericCode` alone (`getSessionByNumericCode`
   already existed). All current join semantics (customerCode, clientId, queue, ≤ 50
   cap, reconnect) are reused unchanged.

Failure ladder on connect: `400 INVALID_SHOP_CODE` (bad format) · `404 SHOP_NOT_FOUND`
(unknown/suspended) · `409 SHOP_OFFLINE` (no live dashboard) · `409 SHOP_NOT_READY`
(online but no live session; a stale pointer is cleared here).

### Why this over the alternatives

- **Vending the raw `joinToken` to scanners** — rejected: the server doesn't hold the
  raw token (only its hash), and persisting the raw token to enable this would weaken
  the token-hashing invariant for no benefit. Handing back the `numericCode` instead
  reuses an existing customer credential without exposing the token.
- **Customer creates its own session** — rejected: breaks the shop-controlled,
  multi-customer-aggregating model (all customers of a shop share one session).
- **Putting the `shopId → sessionId` pointer in SQLite** — rejected: it is ephemeral
  routing state tied to a 15-minute session, not durable shop ownership. Per the
  constraint "do not use the durable store for ephemeral state," it belongs in the
  session store (Redis / in-memory), expiring with the session and cleared on
  `deleteSession`.

### Security posture

- `publicShopId` grants only what the QR is meant to grant: the ability to *attempt* a
  customer connection to an **online** shop. It never grants dashboard/owner access.
- A closed shop (no live dashboard) cannot be connected to — the bridge refuses when
  `online` is false, so a leaked/photographed QR is inert outside business hours.
- The customer receives the session `numericCode`, never the raw `joinToken`; the token
  is returned only to the authenticated shop that created the session.
- The permanent QR and the transfer session remain fully decoupled: rotating,
  expiring, or ending a session never touches the QR, and vice-versa.

### Shop-role ownership tightening (Phase I)

The bridge hands the customer a `sessionId` (and `numericCode`) so it can JOIN as a
*customer*. That created a new question: could a customer replay that `sessionId` to JOIN
as the **shop** and hijack the session? Signaling previously accepted a bare `sessionId`
for the shop role, so — before this phase — yes.

Phase I closes that additively: **the raw `joinToken` is now required for the shop role.**
Because the server stores only the token's hash, only the authenticated shop that created
the session ever holds the raw token; the bridge deliberately never vends it. The rules:

- Shop JOIN with no `token` → `JOIN_REJECTED` code `INVALID_TOKEN` (a bare `sessionId` no
  longer suffices).
- Shop JOIN whose supplied `sessionId` disagrees with the `token`'s session →
  `INVALID_TOKEN` (stitched-together credentials refused).
- Shop JOIN with a valid `token` (with or without a matching `sessionId`) → accepted,
  exactly as before.

This is safe by construction: every existing shop JOIN — client and tests alike — already
sends a matching `token` + `sessionId` pair, so no legitimate path changes. The customer
join paths (token, `numericCode`, reconnect-by-`clientId`) are untouched.

### Additive-only guarantee

The bridge adds a new customer entry path; it does **not** modify or remove the
existing token/`numericCode` join paths, the `ConnectionAttempt` state machine, or the
signaling reconnect logic. All 118 pre-existing tests continue to pass unchanged; Phase
F added 13 tests (server suite 84 → 97, monorepo total 169 → 182). Phase I then added 5
signaling-ownership tests (server 97 → 102, total 182 → 187), again with every prior
test still passing.
