# QuickDrop --- Product Requirements Document (PRD)

**Version:** MVP v0.1\
**Product:** QuickDrop\
**Tagline:** Scan. Send. Print.\
**UI Direction:** Google Pixel / Material 3-inspired, clean, calm,
tactile, minimal.

## 1. Product Summary

QuickDrop is a privacy-first, QR-based temporary document transfer web
application for print shops, Xerox centers, cyber cafés, libraries,
colleges, and similar service counters.

A shop creates a short-lived transfer session and displays a QR code. A
customer scans the QR code, opens the web app without installing
anything or sharing a phone number, selects documents, and transfers
them directly to the shop browser.

The MVP is designed around **WebRTC peer-to-peer data transfer**. A
lightweight backend provides session creation and signaling but does not
permanently store document files. WebRTC data channels are encrypted in
transit using DTLS, and peer-to-peer transfer can avoid
application-server storage of the document payload. [MDN
WebRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)

## 2. Problem

Customers currently send documents to shops through WhatsApp, email,
Telegram, Bluetooth, USB drives, or other channels. This creates
unnecessary friction:

-   Contact numbers may be exchanged.
-   The shop may accumulate customer chats.
-   The customer must find or start a conversation.
-   The file may remain in third-party chat/email history.
-   The shop must manage many customer conversations.
-   The workflow is slower than necessary for a simple print job.

## 3. Goal

Reduce the document-transfer workflow to:

**Open shop page → Generate QR → Customer scans → Selects document →
Sends → Shop receives → Session expires.**

The product should require:

-   No customer account.
-   No customer phone number.
-   No customer contact sharing.
-   No app installation.
-   No permanent document storage.
-   Minimal interaction for the shop operator.

## 4. Non-Goals for MVP

The MVP will NOT include:

-   User accounts for customers.
-   Customer profiles.
-   Long-term document history.
-   Cloud drive functionality.
-   Document editing.
-   OCR.
-   AI document processing.
-   Payment processing.
-   Multi-shop marketplace.
-   Public file sharing.
-   Anonymous permanent links.
-   Automatic printing without operator confirmation.

## 5. Primary Users

### Customer

A person standing at a shop counter with a phone who wants to send one
or more documents for printing.

### Shop Operator

A shop employee using a desktop/laptop browser to receive documents and
print them.

## 6. Core User Stories

### Customer

-   As a customer, I want to scan a QR code and immediately reach the
    upload page.
-   As a customer, I want to send a PDF/DOCX/image without sharing my
    phone number.
-   As a customer, I want to see upload/transfer progress.
-   As a customer, I want confirmation that the shop received my
    document.
-   As a customer, I want my transfer session to expire automatically.

### Shop Operator

-   As a shop operator, I want to create a transfer session with one
    click.
-   As a shop operator, I want a QR code that customers can scan.
-   As a shop operator, I want incoming files to appear automatically.
-   As a shop operator, I want file name, type, size, and transfer
    status.
-   As a shop operator, I want to download/open/print a received file.
-   As a shop operator, I want the session to expire automatically.
-   As a shop operator, I want a simple way to create another session.

## 7. MVP Functional Requirements

### FR-01 Session Creation

The shop browser can create a temporary session.

The backend generates:

-   Session ID
-   One-time/short-lived join token
-   Expiration timestamp
-   Session status

Default expiration: **15 minutes**.

### FR-02 QR Generation

The shop browser displays a QR containing the short-lived join URL.

Recommended structure:

`https://quickdrop.example/join#<short-lived-token>`

Using a URL fragment reduces exposure of the token to normal HTTP
request logs because the fragment is processed by the browser.

### FR-03 Customer Join

Customer scans QR.

The browser:

1.  Opens QuickDrop.
2.  Reads the token from the URL fragment.
3.  Establishes a signaling connection.
4.  Validates the session.
5.  Displays the upload interface.

### FR-04 File Selection

MVP allowed types:

-   PDF
-   DOC
-   DOCX
-   PPT
-   PPTX
-   XLS
-   XLSX
-   JPG/JPEG
-   PNG
-   TXT

Recommended MVP per-file size limit: **50 MB**.

Recommended session transfer limit: **200 MB**.

These limits are product defaults, not universal security standards;
they should be configurable.

### FR-05 File Validation

Client and server-side signaling metadata validation must reject
unsupported extensions, suspicious names, excessive sizes, and malformed
metadata.

For any future server-side upload fallback, MIME type and file signature
must be validated rather than trusting the browser-provided
Content-Type. OWASP recommends allowlisting required extensions,
validating file type/signature, limiting size, using generated
filenames, and applying layered defenses. citeturn0search2

### FR-06 Peer Connection

After session validation, the customer and shop browsers establish an
`RTCPeerConnection`.

A reliable `RTCDataChannel` is used for document transfer.

### FR-07 Transfer Protocol

Files are not sent as one giant WebRTC message.

The application must:

1.  Read the file incrementally.
2.  Split it into chunks.
3.  Send chunks through the data channel.
4.  Apply backpressure using `bufferedAmount`.
5.  Reassemble chunks on the receiving side.
6.  Verify the final file size and checksum.
7.  Produce the file locally in the shop browser.

### FR-08 Transfer Progress

Both sides should see:

-   File name
-   File size
-   Percentage
-   Bytes transferred
-   Transfer speed
-   Estimated remaining time
-   Status

### FR-09 Shop Receipt

When a file is fully received and checksum verification succeeds, the
shop dashboard displays:

`Received — Ready to Print`

### FR-10 Local File Handling

The MVP should keep received files in browser memory/temporary
browser-managed state until the operator downloads/opens them.

The product must not create a permanent application-side file archive.

### FR-11 Session Expiration

When the session expires:

-   New customers cannot join.
-   Existing connections are closed.
-   Pending transfers are cancelled.
-   Temporary session metadata is removed.
-   Customer UI shows `Session expired`.

### FR-12 Manual End Session

Shop operator can terminate a session immediately.

## 8. UX Requirements

The customer experience should require no explanation from the shop
employee.

Target flow:

**Scan QR → Upload → Send → Done**

Maximum expected primary actions: **3 taps/clicks** after QR scanning.

## 9. Success Metrics

### Primary

-   Time from QR scan to first file transfer: **\< 10 seconds** on a
    normal connection.
-   Successful transfer rate: **\> 98%** for supported browser/network
    combinations.
-   Customer phone-number collection: **0**.
-   Persistent document storage by QuickDrop: **0**.

### Secondary

-   QR-to-upload screen: \< 3 seconds on normal mobile network.
-   Transfer UI remains responsive during large transfers.
-   Session creation: \< 1 second server processing time under normal
    load.

## 10. Browser Support

Target:

-   Chrome/Chromium on Android
-   Chrome/Edge on Windows
-   Safari on iOS
-   Firefox where WebRTC behavior supports the required data-channel
    flow

WebRTC data channels are broadly supported in modern browsers.
citeturn0search3

## 11. Accessibility

-   WCAG-oriented contrast.
-   Keyboard navigation on shop dashboard.
-   Visible focus states.
-   Large touch targets.
-   Screen-reader labels.
-   Do not communicate status using color alone.
-   Respect reduced-motion preferences.

## 12. Privacy Principles

QuickDrop should collect as little information as possible.

Do not collect:

-   Phone number
-   Customer name by default
-   Email
-   Contacts
-   Address book
-   Advertising identifiers
-   Document contents
-   Permanent document metadata

Temporary metadata may include:

-   Session ID
-   Creation time
-   Expiration time
-   Connection state
-   File name/size while the session is active

Avoid logging filenames and document metadata in normal application
logs.

## 13. MVP Acceptance Criteria

A release is MVP-ready when:

-   Shop can create a session.
-   QR can be scanned from a phone.
-   Customer reaches upload page.
-   Customer can select supported files.
-   Customer and shop establish WebRTC connection.
-   Files transfer reliably in chunks.
-   Progress is shown.
-   Shop can save/open/print received files.
-   Session expires automatically.
-   No document bytes are persisted by the application backend.
-   Invalid/oversized files are rejected.
-   Rate limits prevent obvious abuse.
-   HTTPS is enforced.
-   Security headers are enabled.
-   Core flow works on Android Chrome + Windows Chrome/Edge.

## 14. Future Roadmap

### V1

-   Multiple simultaneous customers per shop.
-   Multiple files per transfer.
-   Transfer history only for the active session.
-   Optional 4-digit session verification.
-   Shop branding.
-   PWA installability.

### V2

-   WebRTC local-network optimization.
-   Optional server-relay fallback.
-   Printer integration.
-   Print settings.
-   Automatic PDF preview.
-   QR kiosk mode.

### V3

-   Shop account management.
-   Analytics without document content.
-   Multi-terminal shop support.
-   Queue management.
-   Payment integration.

## 15. Product Principle

> **QuickDrop should behave like a temporary digital USB cable: connect,
> transfer, disconnect, forget.**
