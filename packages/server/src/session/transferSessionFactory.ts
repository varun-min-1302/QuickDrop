import crypto from 'node:crypto';
import { SessionMetadata, SessionStatus, PROTOCOL_VERSION } from '@quickdrop/shared';
import { ISessionStore } from '../redis/sessionStore.js';
import { generateSecureToken, hashToken, generateNumericCode } from '../utils/crypto.js';

/** The secrets + identifiers returned to the CREATOR of a transfer session. */
export interface CreatedTransferSession {
  sessionId: string;
  /** Raw joinToken — returned only to the creator (shop). The store keeps only its hash. */
  joinToken: string;
  numericCode: string;
  expiresAt: number;
  status: SessionStatus;
}

/**
 * Build and persist an ephemeral transfer session. Shared by the legacy anonymous
 * `POST /api/sessions` route and the authenticated shop-scoped route so both mint
 * sessions identically. When `shopId` is provided (§16 bridge), the session is linked
 * to the permanent shop and registered as that shop's current session pointer — both
 * expire together with the session TTL. No document bytes are ever stored.
 */
export async function createTransferSession(
  sessionStore: ISessionStore,
  opts: { shopName?: string; ttlSeconds: number; shopId?: string }
): Promise<CreatedTransferSession> {
  const sessionId = crypto.randomUUID();
  const joinToken = generateSecureToken();
  const tokenHash = hashToken(joinToken);
  const numericCode = generateNumericCode();
  const now = Date.now();
  const expiresAt = now + opts.ttlSeconds * 1000;

  const meta: SessionMetadata = {
    sessionId,
    tokenHash,
    numericCode,
    createdAt: now,
    expiresAt,
    status: 'CREATED',
    shopName: opts.shopName,
    shopId: opts.shopId,
    customerCount: 0,
    totalTransferredBytes: 0,
    fileCount: 0,
    protocolVersion: PROTOCOL_VERSION,
  };

  await sessionStore.createSession(meta, opts.ttlSeconds);
  if (opts.shopId) {
    await sessionStore.setShopCurrentSession(opts.shopId, sessionId, opts.ttlSeconds);
  }

  return { sessionId, joinToken, numericCode, expiresAt, status: 'CREATED' };
}
