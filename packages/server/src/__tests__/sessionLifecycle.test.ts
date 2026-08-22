import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../index.js';
import { FastifyInstance } from 'fastify';
import { generateSecureToken, hashToken, generateNumericCode } from '../utils/crypto.js';
import { MemorySessionStore } from '../redis/sessionStore.js';
import { SessionMetadata } from '@quickdrop/shared';

describe('Phase 2 Control Plane: Secure Ephemeral Sessions & Token Security', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const built = await buildApp();
    app = built.fastify;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Cryptographic Token Generation & Entropy', () => {
    it('generates non-sequential 256-bit entropy tokens with zero collision in 1000 samples', () => {
      const tokenSet = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const token = generateSecureToken();
        expect(token).toHaveLength(64); // 32 bytes hex encoded = 64 chars
        expect(tokenSet.has(token)).toBe(false);
        tokenSet.add(token);
      }
      expect(tokenSet.size).toBe(1000);
    });

    it('generates readable 6-character backup codes without ambiguous characters', () => {
      const ambiguousChars = ['0', 'O', '1', 'I'];
      for (let i = 0; i < 100; i++) {
        const code = generateNumericCode();
        expect(code).toHaveLength(6);
        for (const char of ambiguousChars) {
          expect(code).not.toContain(char);
        }
      }
    });

    it('consistently hashes tokens via SHA-256 for secure storage', () => {
      const token = 'sample-random-token-12345';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(hash1).not.toBe(token);
    });
  });

  describe('Session Creation & Expiration Lifecycle', () => {
    it('creates an ephemeral session with 15-minute default TTL via POST /api/sessions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          shopName: 'Library Printing Desk',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(body.joinToken).toHaveLength(64);
      expect(body.numericCode).toHaveLength(6);
      expect(body.status).toBe('CREATED');
      expect(body.protocolVersion).toBe('1.0');

      const expiresAt = new Date(body.expiresAt).getTime();
      const now = Date.now();
      expect(expiresAt - now).toBeGreaterThan(850 * 1000);
      expect(expiresAt - now).toBeLessThanOrEqual(900 * 1000);
    });

    it('rejects invalid or malformed session creation requests with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          ttlSeconds: 99999999, // exceeds max permitted TTL
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid session request');
      expect(body.details).toBeDefined();
    });

    it('rejects invalid non-UUID format session status queries with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/invalid-id-format/status',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid session ID format');
    });

    it('returns 404 for non-existent or expired session status queries', async () => {
      const nonExistentUuid = '00000000-0000-4000-8000-000000000000';
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${nonExistentUuid}/status`,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Session not found or expired');
    });

    it('supports manual early session termination via DELETE /api/sessions/:id', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {},
      });
      const created = JSON.parse(createRes.body);

      // Verify status is CREATED
      const statusBefore = await app.inject({
        method: 'GET',
        url: `/api/sessions/${created.sessionId}/status`,
      });
      expect(statusBefore.statusCode).toBe(200);

      // Terminate
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${created.sessionId}`,
      });
      expect(deleteRes.statusCode).toBe(200);

      // Status should now be 404
      const statusAfter = await app.inject({
        method: 'GET',
        url: `/api/sessions/${created.sessionId}/status`,
      });
      expect(statusAfter.statusCode).toBe(404);
    });

    it('automatically expires session when TTL elapses in session store', async () => {
      const store = new MemorySessionStore();
      const sessionId = '11111111-2222-4333-8444-555555555555';
      const token = 'short-lived-token-abc';
      const tokenHash = hashToken(token);

      const session: SessionMetadata = {
        sessionId,
        tokenHash,
        numericCode: 'XYZ999',
        createdAt: Date.now(),
        expiresAt: Date.now() + 50, // 50ms TTL
        status: 'CREATED',
        customerCount: 0,
        totalTransferredBytes: 0,
        fileCount: 0,
        protocolVersion: '1.0',
      };

      await store.createSession(session, 1); // 1 second TTL in store
      expect(await store.getSession(sessionId)).not.toBeNull();

      // Wait 70ms past expiresAt
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(await store.getSession(sessionId)).toBeNull();
      expect(await store.getSessionByToken(token)).toBeNull();
      await store.close();
    });
  });
});
