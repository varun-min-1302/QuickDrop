# QuickDrop --- User Flow & System Flow

## 1. Primary Customer Flow

``` text
Customer enters shop
        ↓
Sees QuickDrop QR
        ↓
Scans QR with phone camera
        ↓
Browser opens QuickDrop
        ↓
Session validated
        ↓
"Send documents to Shop"
        ↓
Select file(s)
        ↓
Client validates files
        ↓
"Send"
        ↓
WebRTC connection established
        ↓
Transfer begins
        ↓
Progress displayed
        ↓
SHA-256 verified
        ↓
Shop receives file
        ↓
Customer sees "Sent successfully"
        ↓
Customer can close page
```

## 2. Shop Flow

``` text
Shop opens QuickDrop
        ↓
Create Session
        ↓
QR appears
        ↓
Customer scans
        ↓
"Customer connected"
        ↓
Wait for documents
        ↓
File appears
        ↓
Transfer progress
        ↓
"Ready to Print"
        ↓
Operator clicks Open / Download / Print
        ↓
Operator can end session
```

## 3. Detailed Session Flow

### Step 1 --- Create

``` text
POST /api/sessions
```

Backend:

``` text
generate random session ID
generate random join token
store hash/token metadata in Redis
set TTL = 15 minutes
```

Response:

``` text
sessionId
joinToken
expiresAt
```

### Step 2 --- QR

Frontend generates:

``` text
https://quickdrop.example/join#TOKEN
```

QR is displayed.

### Step 3 --- Scan

Customer scans.

Browser reads:

``` javascript
location.hash
```

Token is removed from the visible URL after extraction if appropriate.

### Step 4 --- Join

Customer establishes:

``` text
WSS /ws
```

and sends:

``` json
{
  "type": "JOIN",
  "token": "..."
}
```

### Step 5 --- Validation

Backend checks:

``` text
token exists?
session exists?
session expired?
shop connected?
customer already connected?
rate limit exceeded?
```

If valid:

``` text
JOIN_ACCEPTED
```

### Step 6 --- WebRTC

Shop and customer exchange:

-   SDP offer
-   SDP answer
-   ICE candidates

through signaling.

### Step 7 --- Connection

When:

``` text
RTCDataChannel.readyState === "open"
```

the customer UI changes:

`Connecting...`

to:

`Connected to shop`

### Step 8 --- File Transfer

``` text
FILE_START
    ↓
CHUNK 0
CHUNK 1
CHUNK 2
...
CHUNK N
    ↓
FILE_END
    ↓
SHA-256 verify
    ↓
TRANSFER_COMPLETE
```

### Step 9 --- Receipt

Shop:

``` text
assignment.pdf
2.4 MB
Received
Ready to Print
```

Customer:

``` text
✓ Document sent
```

### Step 10 --- Cleanup

After session expiration or manual close:

``` text
WebRTC connection close
WebSocket close
Redis session delete/expiry
React state cleared
Temporary browser objects released
```

## 4. Error Flows

### QR expired

Customer:

``` text
This QR code has expired.
Please scan the new QR at the shop.
```

### Shop unavailable

``` text
The shop is not currently accepting documents.
Please ask the operator to refresh the QR.
```

### Connection failure

``` text
Connection couldn't be established.

[Try Again]
```

### Transfer failure

``` text
Document transfer failed.

Your original file is still on your phone.

[Retry]
```

### File too large

``` text
This file is larger than the 50 MB limit.
```

### Unsupported file

``` text
This file type isn't supported.
```

## 5. Session State Machine

``` text
                    ┌──────────┐
                    │ CREATED  │
                    └────┬─────┘
                         │ customer joins
                         ▼
                    ┌──────────┐
                    │ CONNECTED│
                    └────┬─────┘
                         │ transfer
                         ▼
                    ┌──────────┐
                    │ TRANSFER │
                    └────┬─────┘
                         │ complete
                         ▼
                    ┌──────────┐
                    │  READY   │
                    └────┬─────┘
                         │ close/timeout
                         ▼
                    ┌──────────┐
                    │  CLOSED  │
                    └──────────┘

Any active state
      │
      │ timeout
      ▼
   EXPIRED
```

## 6. Transfer State Machine

``` text
QUEUED
  ↓
VALIDATING
  ↓
CONNECTING
  ↓
TRANSFERRING
  ↓
VERIFYING
  ↓
COMPLETED
```

Failure:

``` text
ANY STATE
   ↓
FAILED
   ↓
RETRY / CANCEL
```

## 7. Customer UI Screens

### Screen A --- Join

``` text
┌──────────────────────────┐
│                          │
│        QuickDrop         │
│                          │
│    Send files to this    │
│         shop             │
│                          │
│     ● Connected          │
│                          │
│     [ Select files ]     │
│                          │
│  No account required     │
│  No phone number needed  │
│                          │
└──────────────────────────┘
```

### Screen B --- Selected

``` text
┌──────────────────────────┐
│ Send documents            │
│                          │
│ 📄 assignment.pdf         │
│ 2.4 MB                   │
│                          │
│ 📄 notes.docx             │
│ 840 KB                   │
│                          │
│ [ Add more ]             │
│                          │
│       [ Send ]           │
└──────────────────────────┘
```

### Screen C --- Sending

``` text
assignment.pdf

██████████████░░░░ 72%

1.7 MB / 2.4 MB

1.8 MB/s
~0.4 sec remaining
```

### Screen D --- Complete

``` text
✓ Sent successfully

Your documents have been
received by the shop.

You can close this page.
```

## 8. Shop UI Screens

### Session Creation

``` text
QuickDrop

Ready to receive documents

        ┌─────────────┐
        │             │
        │     QR      │
        │             │
        └─────────────┘

Scan this code with your phone

Session expires in 14:32

[ End session ]
```

### Connected

``` text
Customer connected

Waiting for documents...
```

### Received

``` text
Received documents

┌─────────────────────────────────┐
│ assignment.pdf                  │
│ PDF · 2.4 MB                    │
│ ✓ Transfer verified             │
│                                 │
│ [ Open ] [ Print ] [ Delete ]   │
└─────────────────────────────────┘
```

## 9. Privacy Messaging

Customer-facing copy should be simple:

> No account. No phone number. No permanent document storage.

Avoid absolute claims such as:

> "Your file can never be stored anywhere."

The product should explain its actual architecture accurately.

## 10. Happy Path Target

The ideal interaction:

``` text
SCAN
  ↓
SELECT
  ↓
SEND
  ↓
DONE
```

No login.

No OTP.

No phone number.

No typing.

No app installation.
