# QuickDrop --- Technical Requirements Document (TRD)

**Version:** MVP v0.1

## 1. Technical Objective

Build a fast, privacy-first browser application that transfers documents
between a customer's phone and a shop computer without permanent
application-side document storage.

The preferred transport is:

**WebRTC RTCDataChannel**

The backend is a signaling/control plane, not a document storage
service.

WebRTC supports peer-to-peer arbitrary data exchange through
`RTCDataChannel`. WebRTC data channels are encrypted, and the
peer-to-peer design can keep application-server infrastructure out of
the document payload path. citeturn0search0turn0search4

## 2. Recommended MVP Stack

### Frontend

-   React
-   TypeScript
-   Vite
-   Tailwind CSS
-   Material 3-inspired design tokens
-   React Router
-   Zustand or React Context for lightweight state
-   Web Crypto API
-   native WebRTC APIs
-   QR generation library

### Backend

-   Node.js
-   TypeScript
-   Fastify
-   WebSocket (`ws`) for signaling
-   Redis for ephemeral session state
-   Zod for request/schema validation

### Infrastructure

-   Nginx or managed reverse proxy
-   HTTPS/TLS
-   coturn for TURN fallback
-   Redis with TTL
-   Docker
-   Linux VPS/container platform

## 3. Architecture Decision

### Chosen architecture

**Browser ↔ WebRTC ↔ Browser**

with:

**Browser ↔ HTTPS/WebSocket ↔ Signaling Server**

and:

**WebRTC ↔ STUN/TURN infrastructure when required**

### Diagram

``` text
                         ┌──────────────────────┐
                         │   QuickDrop Backend  │
                         │                      │
                         │ HTTPS API            │
                         │ WebSocket Signaling  │
                         │ Redis Session TTL     │
                         └──────────┬───────────┘
                                    │
                      Signaling only│
                                    │
                ┌───────────────────┴──────────────────┐
                │                                      │
        ┌───────▼────────┐                    ┌────────▼───────┐
        │ Customer Phone │                    │ Shop Computer  │
        │ React Web App  │                    │ React Web App  │
        └───────┬────────┘                    └────────┬───────┘
                │                                      │
                └────────── WebRTC DataChannel ────────┘
                              │
                         Document bytes
```

### TURN fallback

``` text
Customer ─────── TURN relay ─────── Shop
                    │
             Encrypted WebRTC
             traffic is relayed
             but not application
             persisted
```

## 4. Why WebRTC

A conventional architecture would be:

`Phone → Upload Server → Shop Download`

That creates temporary server-side document handling and increases
bandwidth and storage requirements.

WebRTC allows:

`Phone → Shop`

while the backend handles signaling.

The WebRTC specification explicitly supports file-transfer use cases and
requires data channels to provide confidentiality, integrity, and source
authentication. citeturn0search8

## 5. Important Reality: TURN

Direct peer-to-peer connectivity is not guaranteed.

Some customers will be behind:

-   Carrier NAT
-   Corporate firewalls
-   Restrictive Wi-Fi
-   Symmetric NAT

Therefore the production architecture needs STUN and TURN.

### Connection strategy

``` text
1. Try direct WebRTC
2. Try server-reflexive path through STUN
3. If direct path fails, use TURN relay
4. If WebRTC still fails, show controlled retry/fallback state
```

The MVP should not pretend that all traffic will always be direct.

## 6. Session Model

Redis stores only ephemeral session metadata.

``` text
Session {
  id: string
  joinTokenHash: string
  createdAt: timestamp
  expiresAt: timestamp
  status: CREATED | CONNECTED | CLOSED | EXPIRED
  shopConnectionId: string
  customerConnectionId?: string
}
```

Redis TTL should match or be slightly shorter than the session
expiration.

## 7. Token Design

Do not use sequential IDs such as:

`/join/1001`

Use cryptographically random tokens.

Recommended:

-   128+ bits of entropy.
-   One-time or short-lived.
-   Server stores only a hash where practical.
-   Token invalidated after session termination.

The QR URL should not contain customer PII.

## 8. Signaling Flow

### Shop

``` text
POST /api/sessions
        ↓
Backend creates random session
        ↓
Redis SETEX session
        ↓
Backend returns join token
        ↓
Frontend renders QR
```

### Customer

``` text
Scan QR
   ↓
Read fragment token
   ↓
Open WebSocket
   ↓
Send JOIN token
   ↓
Backend validates session
   ↓
Allow signaling
```

## 9. WebRTC Negotiation

``` text
Shop creates RTCPeerConnection
        ↓
Shop creates RTCDataChannel("files")
        ↓
Shop creates offer
        ↓
Offer → signaling server
        ↓
Offer → customer
        ↓
Customer creates answer
        ↓
Answer → signaling server
        ↓
Answer → shop
        ↓
ICE candidates exchanged
        ↓
DataChannel opens
```

The data channel should use reliable ordered delivery for document
transfer.

## 10. File Transfer Protocol

Do not send an entire `File` as a single message.

Use a small application protocol.

### Message types

``` text
FILE_START
FILE_CHUNK
FILE_END
TRANSFER_ACK
TRANSFER_CANCEL
ERROR
PING
```

### FILE_START

``` json
{
  "type": "FILE_START",
  "transferId": "random-id",
  "name": "assignment.pdf",
  "size": 2451821,
  "mime": "application/pdf",
  "totalChunks": 38,
  "sha256": "..."
}
```

### FILE_CHUNK

Binary payload:

``` text
transferId
chunkIndex
chunkBytes
```

### FILE_END

``` json
{
  "type": "FILE_END",
  "transferId": "..."
}
```

## 11. Chunking

Recommended starting chunk size:

**64 KiB**

This aligns with conservative RTCDataChannel message-size behavior; MDN
notes a default of 64 KiB when `max-message-size` is not present. The
implementation should still negotiate and adapt rather than hard-code
assumptions. citeturn0search0

The sender must monitor:

``` text
dataChannel.bufferedAmount
```

and pause/resume sending according to a high/low watermark.

## 12. Integrity

Before transfer:

``` text
SHA-256(file)
```

During transfer:

-   Track chunk count.
-   Track expected bytes.
-   Reject duplicate/invalid chunk indices.
-   Reassemble.
-   Verify final SHA-256.

If the checksum does not match:

`Transfer failed — file integrity check failed.`

## 13. Backend APIs

### POST `/api/sessions`

Creates shop session.

Response:

``` json
{
  "sessionId": "...",
  "joinToken": "...",
  "expiresAt": "..."
}
```

### GET `/api/sessions/:id/status`

Returns non-sensitive session state.

### DELETE `/api/sessions/:id`

Ends session.

### WebSocket `/ws`

Used only for:

-   Authentication of session participants.
-   WebRTC SDP exchange.
-   ICE candidate exchange.
-   Connection state signaling.

Document bytes should not be sent through this WebSocket.

## 14. Redis Keys

``` text
qd:session:<sessionId>
qd:ratelimit:<ip>
qd:join:<tokenHash>
```

Every session key must have TTL.

## 15. No Persistent File Storage

The backend should contain no:

-   uploads directory
-   object-storage bucket for document payloads
-   document database table
-   document backup
-   document cache

The application server should not accept document payloads through
normal HTTP upload endpoints in the primary architecture.

## 16. Fallback Strategy

MVP priority:

1.  WebRTC direct.
2.  WebRTC TURN relay.
3.  User-facing retry.

Do NOT silently fall back to persistent cloud upload.

A future server-relay fallback can be implemented as a separately
isolated service with strict temporary storage and deletion guarantees.

## 17. Deployment

### Development

``` text
React/Vite
Node/Fastify
Redis
coturn
Docker Compose
```

### Production

``` text
                    Internet
                       │
                 HTTPS / WSS
                       │
               Reverse Proxy
                       │
          ┌────────────┴────────────┐
          │                         │
      Web Frontend             API/Signaling
                                    │
                                  Redis
                                    │
                               Session TTL

                  WebRTC
                    │
              ┌─────┴─────┐
              │           │
            Direct       TURN
```

## 18. Observability

Never log:

-   File contents.
-   File hashes if they can become identifying.
-   Customer names.
-   Filenames by default.
-   Full QR tokens.
-   SDP containing unnecessary identifying information.

Log:

-   Request duration.
-   Session creation success/failure.
-   Connection state.
-   Transfer success/failure counters.
-   Error category.
-   Aggregate transfer size buckets.

## 19. Performance Targets

### UI

-   Initial JS ideally \< 250 KB compressed for the core customer route.
-   Lazy-load shop dashboard modules.
-   Avoid heavy UI libraries where native CSS/Tailwind is enough.

### Signaling

-   p95 signaling API response \< 200 ms under normal regional load.
-   WebSocket signaling latency should be low enough that connection
    setup feels immediate.

### Transfer

For a 10 MB file, the product should not introduce unnecessary server
upload/download hops.

Actual throughput depends heavily on Wi-Fi/mobile network, browser, NAT
path, and whether TURN is required.

## 20. Scalability

The signaling layer is stateless apart from Redis-backed ephemeral
session state.

Therefore multiple signaling instances can run behind a load balancer.

``` text
                Load Balancer
                 /    |    \
                /     |     \
          Signal-1 Signal-2 Signal-3
                \     |     /
                  Redis
```

WebSocket sticky sessions may simplify connection routing, but the
design should not depend on in-memory session state.

## 21. Failure Handling

### Customer disconnects

Shop sees:

`Customer disconnected`

Session remains available for a short reconnect window.

### Shop disconnects

Customer sees:

`Shop connection lost`

No document should be assumed delivered.

### Transfer interruption

Display:

`Transfer interrupted — Retry`

The MVP can restart the file rather than implementing resumable
transfers.

### Session expiration

Both sides receive:

`Session expired`

and all connections close.

## 22. Technical Acceptance Criteria

-   TypeScript strict mode.
-   No unvalidated WebSocket messages.
-   Zod schemas for signaling messages.
-   Unit tests for session lifecycle.
-   Integration tests for WebSocket signaling.
-   Browser E2E tests for QR → join → transfer.
-   Transfer integrity test using SHA-256.
-   Load test for session creation/signaling.
-   Security tests for token guessing, replay, oversized metadata,
    malformed signaling, and rate limits.
