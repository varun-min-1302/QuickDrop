import { Redis } from 'ioredis';
import { SessionMetadata, SessionStatus } from '@quickdrop/shared';
import { hashToken } from '../utils/crypto.js';

export interface ISessionStore {
  createSession(session: SessionMetadata, ttlSeconds: number): Promise<void>;
  getSession(sessionId: string): Promise<SessionMetadata | null>;
  getSessionByToken(token: string): Promise<SessionMetadata | null>;
  getSessionByNumericCode(code: string): Promise<SessionMetadata | null>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<boolean>;
  setShopConnection(sessionId: string, connectionId: string): Promise<boolean>;
  updateCustomerCount(sessionId: string, delta: number): Promise<boolean>;
  clearShopConnection(sessionId: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  /**
   * Ephemeral "current transfer session for a shop" pointer (spec §16 bridge). Keyed
   * by permanent shopId → ephemeral sessionId, it lives and dies with the session TTL
   * (it is NOT durable shop state and never touches the identity store). Overwriting it
   * simply re-points new customers at the newest session.
   */
  setShopCurrentSession(shopId: string, sessionId: string, ttlSeconds: number): Promise<void>;
  getShopCurrentSession(shopId: string): Promise<string | null>;
  /** Clear the pointer. When `expectedSessionId` is given, only clears if it still matches. */
  clearShopCurrentSession(shopId: string, expectedSessionId?: string): Promise<void>;
  close(): Promise<void>;
}

export class RedisSessionStore implements ISessionStore {
  private client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 800,
      retryStrategy: () => null, // Do not auto-retry endlessly if offline
      enableOfflineQueue: false,
    });
  }

  async init() {
    await this.client.connect();
  }

  private sessionKey(sessionId: string): string {
    return `qd:session:${sessionId}`;
  }

  private tokenKey(tokenHash: string): string {
    return `qd:token:${tokenHash}`;
  }

  private codeKey(numericCode: string): string {
    return `qd:code:${numericCode.toUpperCase()}`;
  }

  private shopCurrentKey(shopId: string): string {
    return `qd:shopcur:${shopId}`;
  }

  async createSession(session: SessionMetadata, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(session);
    const pipeline = this.client.pipeline();
    pipeline.setex(this.sessionKey(session.sessionId), ttlSeconds, serialized);
    pipeline.setex(this.tokenKey(session.tokenHash), ttlSeconds, session.sessionId);
    pipeline.setex(this.codeKey(session.numericCode), ttlSeconds, session.sessionId);
    await pipeline.exec();
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    const data = await this.client.get(this.sessionKey(sessionId));
    if (!data) return null;
    try {
      return JSON.parse(data) as SessionMetadata;
    } catch {
      return null;
    }
  }

  async getSessionByToken(token: string): Promise<SessionMetadata | null> {
    const hashed = hashToken(token);
    const sessionId = await this.client.get(this.tokenKey(hashed));
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  async getSessionByNumericCode(code: string): Promise<SessionMetadata | null> {
    const sessionId = await this.client.get(this.codeKey(code.toUpperCase()));
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    session.status = status;
    const ttl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    await this.client.setex(this.sessionKey(sessionId), ttl, JSON.stringify(session));
    return true;
  }

  async updateCustomerCount(sessionId: string, delta: number): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    
    session.customerCount = Math.max(0, (session.customerCount || 0) + delta);
    
    // Auto-update session status based on customer presence
    if (session.customerCount > 0 && session.status === 'CREATED') {
      session.status = 'CONNECTED';
    } else if (session.customerCount === 0 && (session.status === 'CONNECTED' || session.status === 'TRANSFERRING')) {
      session.status = 'CREATED';
    }

    const ttl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    await this.client.setex(this.sessionKey(sessionId), ttl, JSON.stringify(session));
    return true;
  }

  async setShopConnection(sessionId: string, connectionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    session.shopConnectionId = connectionId;
    const ttl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    await this.client.setex(this.sessionKey(sessionId), ttl, JSON.stringify(session));
    return true;
  }

  async clearShopConnection(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    session.shopConnectionId = undefined;
    const ttl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    await this.client.setex(this.sessionKey(sessionId), ttl, JSON.stringify(session));
    return true;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    const pipeline = this.client.pipeline();
    pipeline.del(this.sessionKey(sessionId));
    pipeline.del(this.tokenKey(session.tokenHash));
    pipeline.del(this.codeKey(session.numericCode));
    await pipeline.exec();
    // Drop the shop→current-session pointer, but only if it still points here.
    if (session.shopId) {
      await this.clearShopCurrentSession(session.shopId, sessionId);
    }
    return true;
  }

  async setShopCurrentSession(shopId: string, sessionId: string, ttlSeconds: number): Promise<void> {
    await this.client.setex(this.shopCurrentKey(shopId), ttlSeconds, sessionId);
  }

  async getShopCurrentSession(shopId: string): Promise<string | null> {
    return this.client.get(this.shopCurrentKey(shopId));
  }

  async clearShopCurrentSession(shopId: string, expectedSessionId?: string): Promise<void> {
    if (expectedSessionId) {
      const current = await this.client.get(this.shopCurrentKey(shopId));
      if (current !== expectedSessionId) return; // a newer session took the pointer
    }
    await this.client.del(this.shopCurrentKey(shopId));
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

export class MemorySessionStore implements ISessionStore {
  private sessions = new Map<string, SessionMetadata>();
  private tokenMap = new Map<string, string>(); // tokenHash -> sessionId
  private codeMap = new Map<string, string>(); // numericCode -> sessionId
  private shopCurrentMap = new Map<string, string>(); // shopId -> sessionId
  private expiryTimers = new Map<string, NodeJS.Timeout>();

  async createSession(session: SessionMetadata, ttlSeconds: number): Promise<void> {
    this.sessions.set(session.sessionId, { ...session });
    this.tokenMap.set(session.tokenHash, session.sessionId);
    this.codeMap.set(session.numericCode.toUpperCase(), session.sessionId);

    const existingTimer = this.expiryTimers.get(session.sessionId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.deleteSession(session.sessionId);
    }, ttlSeconds * 1000);

    if (timer.unref) timer.unref();
    this.expiryTimers.set(session.sessionId, timer);
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      await this.deleteSession(sessionId);
      return null;
    }
    return { ...session };
  }

  async getSessionByToken(token: string): Promise<SessionMetadata | null> {
    const hashed = hashToken(token);
    const sessionId = this.tokenMap.get(hashed);
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  async getSessionByNumericCode(code: string): Promise<SessionMetadata | null> {
    const sessionId = this.codeMap.get(code.toUpperCase());
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    session.status = status;
    this.sessions.set(sessionId, session);
    return true;
  }

  async setShopConnection(sessionId: string, connectionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    session.shopConnectionId = connectionId;
    this.sessions.set(sessionId, session);
    return true;
  }

  async updateCustomerCount(sessionId: string, delta: number): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    
    session.customerCount = Math.max(0, (session.customerCount || 0) + delta);
    
    // Auto-update session status based on customer presence
    if (session.customerCount > 0 && session.status === 'CREATED') {
      session.status = 'CONNECTED';
    } else if (session.customerCount === 0 && (session.status === 'CONNECTED' || session.status === 'TRANSFERRING')) {
      session.status = 'CREATED';
    }

    this.sessions.set(sessionId, session);
    return true;
  }

  async clearShopConnection(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    session.shopConnectionId = undefined;
    this.sessions.set(sessionId, session);
    return true;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.tokenMap.delete(session.tokenHash);
    this.codeMap.delete(session.numericCode.toUpperCase());
    if (session.shopId && this.shopCurrentMap.get(session.shopId) === sessionId) {
      this.shopCurrentMap.delete(session.shopId);
    }
    const timer = this.expiryTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(sessionId);
    }
    return true;
  }

  async setShopCurrentSession(shopId: string, sessionId: string, _ttlSeconds: number): Promise<void> {
    // The pointer is cleared when its session is deleted (incl. the TTL expiry timer),
    // so it never outlives the session it references.
    this.shopCurrentMap.set(shopId, sessionId);
  }

  async getShopCurrentSession(shopId: string): Promise<string | null> {
    return this.shopCurrentMap.get(shopId) ?? null;
  }

  async clearShopCurrentSession(shopId: string, expectedSessionId?: string): Promise<void> {
    if (expectedSessionId && this.shopCurrentMap.get(shopId) !== expectedSessionId) return;
    this.shopCurrentMap.delete(shopId);
  }

  async close(): Promise<void> {
    for (const timer of this.expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
    this.sessions.clear();
    this.tokenMap.clear();
    this.codeMap.clear();
    this.shopCurrentMap.clear();
  }
}
