# Shop-Owner Authentication

Status: **implemented (Phase C)** · Spec §7–§9 · Related: [shop-identity](./shop-identity.md), [auth-security](./auth-security.md)

This document describes how a shop **owner** authenticates. This is the *permanent*
identity layer and is completely separate from the temporary customer transfer
session and the ephemeral WebRTC connection (see [shop-identity](./shop-identity.md)
for the five distinct concepts).

## Endpoints

All paths are under the `/api` prefix. Request/response DTOs are defined in
`@quickdrop/shared` (`schemas/auth.ts`) and contain **no secret-bearing fields**.

| Method | Path | Auth? | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | no | Create an owner account and start a session. |
| `POST` | `/api/auth/login` | no | Verify credentials and start a session. |
| `POST` | `/api/auth/logout` | no¹ | Revoke the current session (idempotent). |
| `GET`  | `/api/auth/me` | no² | Session probe — reports whether the caller is signed in. |

¹ Logout reads the cookie if present but never requires a valid session — it always
succeeds and clears the cookie. ² `/auth/me` is anonymous-safe: it always returns
`200` with `{ authenticated: false }` for anonymous callers rather than `401`.

### Request / response shapes

```
POST /api/auth/register   { email, password }        → 201 { authenticated: true, user }
POST /api/auth/login      { email, password }         → 200 { authenticated: true, user }
POST /api/auth/logout     (cookie)                     → 200 { success: true }
GET  /api/auth/me         (cookie)                     → 200 { authenticated, user? }
```

`user` is the safe DTO `{ id, email, createdAt }` — **never** `passwordHash` or any
secret. `password` is accepted only in the request body over TLS; it is validated
(`≥ 8` chars) then handed straight to the hashing service and discarded.

### Status codes

| Code | When |
| --- | --- |
| `400 INVALID_REQUEST` | Body fails validation (bad email, password too short). No field values are echoed. |
| `401 INVALID_CREDENTIALS` | Login: wrong password **or** unknown email — deliberately identical, so the response does not reveal whether an email is registered. |
| `401 UNAUTHENTICATED` | A protected route (later phases) was called without a valid session. |
| `409 EMAIL_IN_USE` | Register: the email already has an account. |
| `429` | Rate limit exceeded (see below). |

> `401` = *not authenticated*. `403` = *authenticated but not authorized* (used by
> shop-ownership checks in later phases). These are never conflated.

## Session model

- On register/login the server generates a 256-bit random **session token**, stores
  only its **SHA-256 hash** in the `auth_sessions` table (server-side, revocable),
  and returns the *raw* token **only** as an HttpOnly cookie.
- Every authenticated request re-derives the hash from the cookie and looks up the
  session; there is no self-validating JWT, so **logout / take-over revoke instantly**
  by deleting the row.
- Sessions expire after `AUTH_SESSION_TTL_SECONDS` (default 30 days). Expired or
  orphaned (user-deleted) sessions are pruned lazily on access.

### The `qd_auth` cookie

| Attribute | Value | Why |
| --- | --- | --- |
| `HttpOnly` | always | JS cannot read the token → immune to XSS token theft. |
| `Signed` | always | Tamper-evident; forged values fail before any DB lookup. |
| `Secure` | production only | Dev/CI run over plain HTTP; prod requires HTTPS. |
| `SameSite` | `Lax` | CSRF mitigation. Works in dev because Vite proxies `/api` + `/ws` to the server, so the browser treats them as **same-origin** (`packages/client/vite.config.ts`). |
| `Path` | `/` | Sent to both REST and the WS upgrade request. |
| `Max-Age` | `AUTH_SESSION_TTL_SECONDS` | Matches the server-side session lifetime. |

The cookie is signed with `COOKIE_SECRET`. Like `REDIS_URL`, this secret is
**mandatory in production** — `buildApp` throws on startup if it is missing. In
dev/test an ephemeral per-process secret is generated so signing still works locally
(a restart invalidates dev cookies, which is fine).

## `requireAuth` guard

`makeRequireAuth(authService)` returns a Fastify `preHandler` that:

1. reads + unsigns the `qd_auth` cookie,
2. validates the token against the session store (expiry + user existence),
3. on success attaches `request.authUser` (safe DTO) and `request.authSessionId`,
4. on failure replies `401 UNAUTHENTICATED` and the handler never runs.

Shop-ownership authorization (`403`) is layered *on top* of this in later phases and
always re-checks membership server-side — the browser-supplied shop identity is
never trusted.

## What registration does **not** do

Registering creates a **user account only**. It does *not* create a shop. Shop
creation (permanent `publicShopId`, owner membership) is a separate, authenticated
step — see [shop-identity](./shop-identity.md), Phase D. This is deliberate: it keeps
"who you are" separate from "which shop you own", and means refreshing a page never
silently creates a shop.

## Brute-force protection (§20)

`/auth/register` and `/auth/login` carry a per-route rate limit of
`AUTH_RATE_LIMIT_MAX_PER_MINUTE` (default 10) attempts/min/IP, enforced by
`@fastify/rate-limit`. The limiter is registered in dev/prod and skipped under test;
the per-route config is a harmless no-op when the plugin is absent.

## Security invariants (verified by tests)

- Password never appears in any response body, log line, or the identity store in
  plaintext — only as a `scrypt$…` hash (`auth.test.ts`).
- The session token exists only in the HttpOnly signed cookie — never in the body,
  never in `localStorage`, never in a URL.
- Logout revokes server-side: replaying the *same validly-signed* cookie after
  logout returns `{ authenticated: false }`.
- Forged/garbage cookie values fail the signature check and are treated as anonymous.
- Wrong-password and unknown-email logins are indistinguishable (timing-padded with a
  dummy hash; identical `401` response).
