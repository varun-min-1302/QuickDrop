# QuickDrop

> **Scan. Send. Print.**  
> A privacy-first, zero-account, QR-based temporary document transfer platform for print shops, cyber cafés, and document counters.

---

## 🚀 Key Architectural Highlights

* **100% Peer-to-Peer Document Transfer**: Documents stream directly between customer and shop browsers over WebRTC `RTCDataChannel`.
* **Zero Cloud Storage**: The application backend never accepts or stores document files (No S3, Firebase, Supabase, or local upload directories).
* **Zero Friction**: No customer login, no phone number collection, no email, no app installation.
* **Ephemeral Sessions**: Sessions automatically self-destruct via Redis TTL after 15 minutes.
* **Integrity & Backpressure**: 64 KiB chunked binary streaming with `bufferedAmount` backpressure control and SHA-256 pre/post-transfer verification.
* **Google Pixel / Material 3 Aesthetic**: Tactile, calm, clean UI with light/dark theme support.

---

## 📦 Project Structure

```
QuickDrop/
├── packages/
│   ├── shared/         # Zod schemas, chunking protocol framing, constants
│   ├── server/         # Fastify HTTP REST API + WebSocket signaling gateway + Redis TTL
│   └── client/         # React + Vite + Tailwind CSS + Material 3 UI components
├── docker/             # coturn, nginx, and Dockerfiles
├── docker-compose.yml  # Single-command full stack containerization
└── package.json        # npm monorepo workspaces configuration
```

---

## ⚡ Quick Start (Local Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Tests
```bash
npm test
```

### 3. Start Development Servers
```bash
npm run dev
```
* **Frontend**: [http://localhost:5173](http://localhost:5173) (Shop dashboard: [http://localhost:5173/shop](http://localhost:5173/shop))
* **Backend API & Signaling**: [http://localhost:3000](http://localhost:3000)

---

## 🐳 Docker Deployment

To launch the full production stack including Redis, coturn TURN server, Fastify backend, and Nginx frontend:

```bash
docker compose up --build -d
```

Access the application at `http://localhost`.

---

## 🔒 Security & Privacy Guarantees

1. **DTLS Transit Encryption**: All WebRTC DataChannels are encrypted at the transport layer using Datagram Transport Layer Security (DTLS).
2. **Ephemeral Signaling**: Join tokens are passed strictly in URL fragments (`#token`), preventing exposure in HTTP access logs.
3. **Strict Validation**: File names, extensions, MIME types, and message envelopes are strictly validated with Zod and sanitizers to prevent path traversal and XSS.
4. **Memory-Only Document Lifetime**: Received documents are assembled as browser Blobs and released upon session termination or page reload.
