# Auth & Session Security Decision Record

> Status: **accepted** · Decided before implementation, per the production-architecture spec §24 / §8.

## Who authenticates

**Shop owners only.** Customers never create accounts — no email, password, login, or phone number
is ever collected from a customer. A customer's entire interaction is: scan the permanent QR →
connect over WebRTC → send documents. (Spec §2.)

## Password handling (§2, §19)

- MVP credential is **email + password**.
- Passwords are hashed with **scrypt** (Node's built-in `crypto.scrypt`) using a per-user random
  16-byte salt. Stored format: `scrypt$N$r$p$<saltHex>$<hashHex>`. No plaintext, ever.
- Verification uses `crypto.timingSafeEqual` on the derived keys to avoid timing leaks.
- Passwords are **never** logged, returned in API responses, stored in `localStorage`, placed in a
  URL, or included in any WebSocket message. Password hashes never leave the server.
- `scrypt` is a Node built-in, so password hashing adds **no new dependency**.

## Auth session transport — HttpOnly cookie + server-side record

**Decision: an opaque, high-entropy session token in a cookie, backed by a revocable server-side
`AuthSession` row.** (Chosen over a stateless signed/JWT cookie.)

- On login the server mints a 256-bit random token, stores only its SHA-256 hash in the
  `auth_sessions` table (keyed by `tokenHash`), and sets it as a cookie.
- **Cookie attributes:** `HttpOnly` (JS cannot read it → XSS can't exfiltrate it), `SameSite=Lax`,
  `Path=/`, and `Secure` in production (HTTPS). The cookie is **signed** with `COOKIE_SECRET` via
  `@fastify/cookie` for tamper-evidence.
- **No auth token in `localStorage`.** The only client-visible auth state is a non-sensitive
  "am I logged in" flag derived from the `/api/auth/me` endpoint; the credential itself is never
  readable by JS.

### Why server-side records (not stateless JWT)

The spec requires **instant revocation** in several places, which a stateless token cannot do
without a server-side denylist (which is server-side state anyway):

- **§7 logout** deletes the `AuthSession` row → the cookie is dead on the next request.
- **§11 / §12 device take-over** must revoke Laptop A the moment Laptop B takes over. This is
  modelled by the separate `DashboardDeviceSession` (one active device per shop) plus, if desired,
  revoking A's auth session. See [dashboard-devices.md](dashboard-devices.md).
- **§19 session expiration** is enforced server-side (`expiresAt`), independent of any client clock.

## Authorization model (§9)

Every shop-management endpoint runs the same ladder:

1. **Authenticated?** Resolve the `AuthSession` from the cookie → a `User`. If absent/expired →
   **401 Unauthorized**.
2. **Member of the target shop?** Look up `ShopMembership(shopId, userId)`. If the user is
   authenticated but not a member/owner of the requested shop → **403 Forbidden**.
3. **Server resolves shop identity.** The shop is resolved from the authenticated user's
   membership (or an explicit id that is then authorization-checked) — the server **never trusts a
   browser-supplied shop identity** for authorization, and never uses `peerId` or a browser-random
   id as the authoritative shop identity (§12).

Error bodies are generic ("Unauthorized" / "Forbidden") and never leak whether some *other*
private shop exists, nor stack traces (§9, §23).

## Rate limiting (§20, §J)

Login, shop resolution, customer transfer-session creation, and WebSocket JOIN are rate-limited to
blunt brute-force and flooding — but tuned so a busy print shop serving many customers per day is
never throttled in normal use.

**Implemented (Phase J).** A global per-IP bucket (`RATE_LIMIT_MAX_PER_MINUTE`, default 120/min via
`@fastify/rate-limit`) covers all routes, and the sensitive endpoints attach tighter **per-route**
buckets on top (each an independent per-IP counter):

| Endpoint | Bucket (per-IP / minute) | Config knob |
|---|---|---|
| `POST /api/auth/register`, `POST /api/auth/login` | 10 (tightest) | `AUTH_RATE_LIMIT_MAX_PER_MINUTE` |
| `POST /api/shops/:publicShopId/dashboard/claim` (take-over) | 20 | `DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE` |
| `GET /api/public/shops/:publicShopId` (resolve) | 30 | `PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE` |
| `POST /api/public/shops/:publicShopId/connect` (bridge) | 30 | `PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE` |
| everything else | 120 (global) | `RATE_LIMIT_MAX_PER_MINUTE` |

Auth stays the tightest (credential brute-force); the take-over-capable dashboard claim and the
public customer endpoints are stricter than the global default but generous enough for real scan →
resolve → connect retries. Over-limit requests get a uniform `429 { statusCode, error: 'Too Many
Requests', message }` envelope.

The WebSocket JOIN path has its own independent throttle — a per-connection message-rate window in
the signaling server (`MAX_WEBSOCKET_MESSAGES_PER_WINDOW`), separate from the HTTP buckets.

**Testing note.** The HTTP limiter plugin is skipped when `NODE_ENV=test` so suites can fire many
requests freely. The Phase J tests opt back in with `buildApp(..., { forceRateLimit: true, rateLimits })`
to exercise the real routes with tiny buckets and assert genuine `429`s; a regression test confirms
the default (plugin skipped) still lets legitimate repeated traffic through.

## Threat protections (§19) — where each lives

| Protection | Location |
|---|---|
| Password hashing (scrypt) | `packages/server/src/auth/password.ts` |
| Secure auth session (HttpOnly cookie + server record) | `@fastify/cookie` + `auth_sessions` table |
| Login rate limiting | login route config (`@fastify/rate-limit`) |
| Sensitive-endpoint rate limiting (claim / resolve / connect) | per-route buckets, §J (see above) |
| Session expiration | `AuthSession.expiresAt`, checked server-side |
| Logout / revocation | `DELETE /api/auth/logout`, device revoke |
| Authorization middleware | `requireAuth`, `requireShopMembership` preHandlers |
| Ownership checks | membership lookup on every shop API |
| Server-side shop resolution | shop routes resolve from membership, not client input |
| No credentials in QR / URLs | QR carries only `publicShopId` |
| No document storage | WebRTC DataChannel only; DB stores metadata only |
