# QuickDrop --- Architecture, Security & Performance Specification

## 1. Architecture Principles

### Principle 1 --- Data plane and control plane are separate

**Control plane**

-   Session creation
-   Authentication of session participants
-   Signaling
-   Expiration
-   Rate limiting

**Data plane**

-   Document transfer over WebRTC DataChannel

This prevents the signaling backend from becoming a document-storage
system.

### Principle 2 --- Ephemeral by design

Every session has a strict TTL.

Nothing should be designed around permanent customer documents.

### Principle 3 --- Least privilege

Customer can only:

-   Join the specific session.
-   Send documents.
-   Receive transfer status.

Customer cannot:

-   List other sessions.
-   Discover shop sessions.
-   Access another customer's transfer.
-   Query historical documents.

### Principle 4 --- Zero trust

Never assume that:

-   QR token is sufficient forever.
-   Client metadata is trustworthy.
-   MIME type is correct.
-   WebSocket messages are valid.
-   File extension represents actual content.

## 2. Threat Model

### Threat: Session guessing

Attack:

Attacker attempts random session IDs.

Mitigation:

-   128+ bit random token.
-   Short TTL.
-   Rate limiting.
-   No sequential IDs.

### Threat: QR replay

Attack:

Someone photographs the QR and joins later.

Mitigation:

-   Short expiration.
-   Optional one-time join.
-   Optional shop confirmation code.
-   Automatically close session after successful customer pairing.

### Threat: Unauthorized participant

Mitigation:

-   Token validation.
-   Session state validation.
-   One customer peer per session in MVP.
-   Reject duplicate customer connections.

### Threat: Malicious file

The browser is ultimately receiving arbitrary user-controlled bytes.

For a pure P2P MVP, QuickDrop should avoid parsing or executing document
content on its server.

For future server-side upload/fallback features, use OWASP's layered
upload protections: allowlisted extensions, MIME/content validation,
file signatures, generated filenames, file size limits, authorization,
safe storage, and malware/CDR controls where appropriate.
citeturn0search2

### Threat: XSS through filename

Never inject filenames using raw HTML.

Use:

``` tsx
<span>{file.name}</span>
```

not:

``` tsx
dangerouslySetInnerHTML
```

### Threat: Path traversal

Never use customer filename as an operating-system path.

The shop browser should create a browser download using a safe
client-side filename.

If server storage is ever introduced, generate server-side filenames and
keep storage outside the web root. OWASP specifically recommends
generated filenames and safe storage locations. citeturn0search2

### Threat: Denial of service

Attacker repeatedly creates sessions or sends huge metadata.

Mitigation:

-   IP rate limits.
-   Session creation limits.
-   Maximum file size.
-   Maximum files per session.
-   Maximum total transfer size.
-   WebSocket message size limit.
-   Maximum metadata length.
-   Connection timeout.
-   Redis TTL.

### Threat: Memory exhaustion

Do not buffer entire files unnecessarily.

Use:

``` text
File slice → chunk → send → release
```

and:

``` text
received chunks → bounded buffering → Blob
```

For large files, consider browser File System Access API where
supported, with a memory-buffered fallback.

### Threat: Signaling injection

Validate every signaling message against a schema.

Example:

``` text
type
sessionId
peerId
payload
```

Only allow expected message types.

Never trust arbitrary SDP/ICE metadata from an unauthenticated
participant.

### Threat: Token leakage

Avoid logging join tokens.

Prefer QR fragments.

Do not include tokens in analytics URLs.

Use:

``` text
Cache-Control: no-store
Referrer-Policy: no-referrer
```

where appropriate.

## 3. Browser Security Headers

Recommended baseline:

``` text
Content-Security-Policy
Strict-Transport-Security
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy
Cross-Origin-Opener-Policy
Cross-Origin-Resource-Policy
```

CSP should be restrictive and generated according to actual frontend
requirements.

## 4. HTTPS

Production must use HTTPS.

WebRTC and modern browser APIs are designed around secure contexts.

Development may use localhost.

## 5. CORS

Do not use:

``` text
Access-Control-Allow-Origin: *
```

for authenticated/control APIs.

Use an explicit production origin allowlist.

## 6. CSRF

The MVP's session APIs should avoid cookie-based authentication where
possible.

Use short-lived authorization tokens and validate the Origin header for
WebSocket/API operations where appropriate.

If cookie authentication is introduced later, implement CSRF protection.

## 7. Privacy

### Never collect by default

-   Phone number
-   Email
-   Contacts
-   GPS location
-   Customer account
-   Document content

### Temporary metadata

Keep only what is needed for the active session.

Delete it at expiration.

## 8. WebRTC Security

WebRTC data channels are encrypted using DTLS. citeturn0search0

The architecture should still treat WebRTC as a transport, not an
authorization mechanism.

Application authorization happens before the data channel is accepted.

## 9. TURN Security

TURN credentials must be:

-   Short-lived.
-   Generated dynamically where practical.
-   Scoped to the application.
-   Rate-limited.

Do not expose a permanent TURN username/password in frontend source.

## 10. File Validation

For P2P MVP:

``` text
Client selects file
      ↓
Client checks extension/size
      ↓
Shop validates metadata
      ↓
Transfer
      ↓
SHA-256 verification
```

The shop should not execute or automatically open files.

The operator explicitly chooses:

`Download` / `Open` / `Print`

## 11. Performance Architecture

### Customer route

Keep the customer page extremely small.

Load only:

-   Upload component
-   Transfer engine
-   QR session logic
-   Minimal design system

### Shop route

Load:

-   QR generator
-   Session management
-   Transfer dashboard
-   Print controls

Lazy-load nonessential functionality.

## 12. Transfer Performance

Use:

``` text
64 KiB initial chunks
```

and dynamically tune based on:

-   `bufferedAmount`
-   connection state
-   observed throughput

Example policy:

``` text
HIGH_WATER_MARK = 4 MiB
LOW_WATER_MARK  = 1 MiB
```

Pseudo-flow:

``` text
while file remains:
    wait until bufferedAmount < LOW_WATER_MARK
    read next chunk
    send chunk
    update progress
```

Do not continuously enqueue hundreds of megabytes into the
RTCDataChannel.

## 13. Parallel Transfers

MVP recommendation:

-   One customer per shop session.
-   Multiple files sequentially.
-   One reliable data channel.

This keeps the protocol simple.

Later:

-   Multiple customer sessions.
-   Parallel independent transfers.
-   Queue management.

## 14. Performance Measurement

Track:

``` text
time_to_join
time_to_webrtc_connected
file_size
transfer_duration
average_throughput
turn_used
transfer_success
transfer_failure_reason
```

Do not associate these metrics with personal identities.

## 15. Availability

The most important availability dependency is signaling.

If signaling is unavailable:

-   Existing WebRTC connections may continue depending on
    implementation.
-   New sessions cannot be created.
-   New peers cannot negotiate.

Deploy at least two signaling instances before claiming high
availability.

## 16. Recommended MVP Deployment

``` text
                         Cloud
                           │
                     HTTPS / WSS
                           │
                     Reverse Proxy
                           │
                 ┌─────────┴─────────┐
                 │                   │
          React Static App      Fastify API
                                     │
                                  Redis
                                     │
                               Session TTL

                         WebRTC
                      /           \
                 Direct           TURN
```

## 17. Security Definition of Done

Before MVP release:

-   [ ] HTTPS only in production.
-   [ ] Strong random session tokens.
-   [ ] Token TTL implemented.
-   [ ] Token replay protection.
-   [ ] Rate limiting.
-   [ ] WebSocket schema validation.
-   [ ] Maximum metadata lengths.
-   [ ] File size limits.
-   [ ] Allowed file types.
-   [ ] No server-side document persistence.
-   [ ] No sensitive logs.
-   [ ] CSP and security headers.
-   [ ] CORS allowlist.
-   [ ] TURN credentials protected.
-   [ ] SHA-256 transfer verification.
-   [ ] Automated session cleanup.
-   [ ] Dependency vulnerability scanning.
-   [ ] E2E security tests.
-   [ ] Abuse/DoS test cases.

## 18. Important Security Caveat

"Nothing is stored" must be treated as an architectural requirement, not
a marketing assumption.

Application storage can be avoided, but infrastructure can still create
transient operational data such as:

-   reverse-proxy logs,
-   monitoring metrics,
-   TURN relay traffic,
-   browser cache,
-   operating-system temporary data.

Therefore the production deployment must configure logging, caching,
monitoring, backups, and TURN behavior consistently with the privacy
promise.

The strongest product claim should be:

> **QuickDrop does not persist customer documents in application
> storage.**
