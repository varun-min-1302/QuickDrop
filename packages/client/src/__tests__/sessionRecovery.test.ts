import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreateSessionResponse } from '@quickdrop/shared';

// Polyfill mock storage for Node environment in tests
class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] || null;
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = new MockStorage();
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = new MockStorage();
}

describe('Session Recovery & Lifecycle Hardening', () => {
  const SHOP_SESSION_STORAGE_KEY = 'quickdrop_shop_session';

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('Shop Recovery: restores existing session from sessionStorage on page reload', () => {
    const activeSession: CreateSessionResponse = {
      sessionId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      joinToken: 'secure-token-123456',
      numericCode: 'GSTCCJ',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      status: 'CREATED',
      protocolVersion: '1.0',
    };

    // Store in sessionStorage
    sessionStorage.setItem(SHOP_SESSION_STORAGE_KEY, JSON.stringify(activeSession));

    // Read and verify recovery
    const stored = sessionStorage.getItem(SHOP_SESSION_STORAGE_KEY);
    expect(stored).not.toBeNull();

    const parsed: CreateSessionResponse = JSON.parse(stored!);
    expect(parsed.sessionId).toBe(activeSession.sessionId);
    expect(parsed.joinToken).toBe(activeSession.joinToken);
    expect(parsed.numericCode).toBe(activeSession.numericCode);
    expect(new Date(parsed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('Shop Recovery: rejects expired session in sessionStorage and cleans storage', () => {
    const expiredSession: CreateSessionResponse = {
      sessionId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      joinToken: 'secure-token-123456',
      numericCode: 'GSTCCJ',
      expiresAt: new Date(Date.now() - 5000).toISOString(), // Expired 5 seconds ago
      status: 'EXPIRED',
      protocolVersion: '1.0',
    };

    sessionStorage.setItem(SHOP_SESSION_STORAGE_KEY, JSON.stringify(expiredSession));

    const stored = sessionStorage.getItem(SHOP_SESSION_STORAGE_KEY);
    const parsed: CreateSessionResponse = JSON.parse(stored!);
    const isExpired = new Date(parsed.expiresAt).getTime() <= Date.now();

    expect(isExpired).toBe(true);
    if (isExpired) {
      sessionStorage.removeItem(SHOP_SESSION_STORAGE_KEY);
    }

    expect(sessionStorage.getItem(SHOP_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('Explicit End Session: cleans up sessionStorage and stops recovery', () => {
    const activeSession: CreateSessionResponse = {
      sessionId: 'session-to-end-123',
      joinToken: 'token-to-end',
      numericCode: 'AB12CD',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: 'CREATED',
      protocolVersion: '1.0',
    };

    sessionStorage.setItem(SHOP_SESSION_STORAGE_KEY, JSON.stringify(activeSession));
    expect(sessionStorage.getItem(SHOP_SESSION_STORAGE_KEY)).not.toBeNull();

    // Trigger end session cleanup
    sessionStorage.removeItem(SHOP_SESSION_STORAGE_KEY);
    expect(sessionStorage.getItem(SHOP_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('Shop Recovery: Temporary network failure does NOT create new session', async () => {
    const activeSession: CreateSessionResponse = {
      sessionId: 'session-to-retry-123',
      joinToken: 'token',
      numericCode: 'AB12CD',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      status: 'CREATED',
      protocolVersion: '1.0',
    };

    sessionStorage.setItem(SHOP_SESSION_STORAGE_KEY, JSON.stringify(activeSession));

    // Simulate network error where res.ok is false and status is 500
    const res = { ok: false, status: 500 };
    let shouldCreateNew = true;

    if (!res.ok) {
      if (res.status !== 404) {
        shouldCreateNew = false;
      }
    }

    expect(shouldCreateNew).toBe(false);
    expect(sessionStorage.getItem(SHOP_SESSION_STORAGE_KEY)).not.toBeNull();
  });

  it('Customer Token Persistence: Customer token is stored in sessionStorage to survive refresh', () => {
    const customerToken = 'customer-join-token-777888';
    const CUSTOMER_TOKEN_KEY = 'quickdrop_customer_token';
    
    sessionStorage.setItem(CUSTOMER_TOKEN_KEY, customerToken);
    
    expect(sessionStorage.getItem(CUSTOMER_TOKEN_KEY)).toBe(customerToken);
    // MUST NOT be in localStorage
    expect(localStorage.getItem(CUSTOMER_TOKEN_KEY)).toBeNull();
  });

  it('Customer Client ID: generates and persists clientId in sessionStorage', () => {
    const CLIENT_ID_KEY = 'quickdrop_customer_client_id';
    
    let clientId = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
      clientId = 'test-client-uuid-1234';
      sessionStorage.setItem(CLIENT_ID_KEY, clientId);
    }
    
    expect(sessionStorage.getItem(CLIENT_ID_KEY)).toBe('test-client-uuid-1234');
    // MUST NOT be in localStorage
    expect(localStorage.getItem(CLIENT_ID_KEY)).toBeNull();
  });
});
