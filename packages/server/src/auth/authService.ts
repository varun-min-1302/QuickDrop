import crypto from 'node:crypto';
import type { AuthUser } from '@quickdrop/shared';
import { IIdentityStore, UserRecord, UniqueConstraintError } from '../identity/index.js';
import { generateSecureToken, hashToken } from '../utils/crypto.js';
import { hashPassword, verifyPassword } from './password.js';

/** Thrown when registration is attempted with an already-registered email. */
export class EmailInUseError extends Error {
  constructor() {
    super('That email is already registered.');
    this.name = 'EmailInUseError';
  }
}

/** Thrown when login credentials do not match. Deliberately vague (no user enumeration). */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password.');
    this.name = 'InvalidCredentialsError';
  }
}

/** Result of a successful register/login: the safe user + the raw session token (for the cookie). */
export interface AuthResult {
  user: AuthUser;
  /** Raw, un-hashed session token. Set as the HttpOnly cookie value; never persisted in plaintext. */
  token: string;
  expiresAt: number;
}

/** A validated session: the safe user plus the owning auth-session id (for touch/logout). */
export interface ValidatedSession {
  user: AuthUser;
  authSessionId: string;
}

/**
 * Owner authentication service (spec §7, §8). Encapsulates password hashing, the
 * server-side revocable auth-session lifecycle, and the mapping from persisted
 * `UserRecord` to the safe, wire-facing `AuthUser`. Routes stay thin.
 *
 * The identity store is the permanent source of truth; this class never touches the
 * ephemeral transfer-session store and never stores document bytes.
 */
export class AuthService {
  constructor(
    private readonly store: IIdentityStore,
    private readonly authSessionTtlSeconds: number
  ) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const now = Date.now();
    const passwordHash = await hashPassword(password);
    const user: UserRecord = {
      id: crypto.randomUUID(),
      email,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.createUser(user);
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw new EmailInUseError();
      throw err;
    }
    const { token, expiresAt } = await this.createSession(user.id, now);
    return { user: toAuthUser(user), token, expiresAt };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const now = Date.now();
    const user = await this.store.getUserByEmail(email);
    if (!user) {
      // Spend comparable time hashing so a missing account isn't detectably faster.
      await verifyPassword(password, await getDummyHash());
      throw new InvalidCredentialsError();
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw new InvalidCredentialsError();

    const { token, expiresAt } = await this.createSession(user.id, now);
    return { user: toAuthUser(user), token, expiresAt };
  }

  /** Validate a raw session token from the cookie. Returns null if absent/expired/unknown. */
  async validateToken(token: string): Promise<ValidatedSession | null> {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = await this.store.getAuthSessionByTokenHash(tokenHash);
    if (!session) return null;

    const now = Date.now();
    if (session.expiresAt <= now) {
      await this.store.deleteAuthSession(session.id);
      return null;
    }
    const user = await this.store.getUserById(session.userId);
    if (!user) {
      // Orphaned session (user gone) — clean it up and treat as unauthenticated.
      await this.store.deleteAuthSession(session.id);
      return null;
    }
    await this.store.touchAuthSession(session.id, now);
    return { user: toAuthUser(user), authSessionId: session.id };
  }

  /** Revoke a single session by its raw token (logout on this device). */
  async logout(token: string): Promise<void> {
    if (!token) return;
    const session = await this.store.getAuthSessionByTokenHash(hashToken(token));
    if (session) await this.store.deleteAuthSession(session.id);
  }

  /** Revoke every session for a user (logout everywhere / password change). */
  async logoutEverywhere(userId: string): Promise<void> {
    await this.store.deleteAuthSessionsForUser(userId);
  }

  private async createSession(userId: string, now: number): Promise<{ token: string; expiresAt: number }> {
    const token = generateSecureToken();
    const expiresAt = now + this.authSessionTtlSeconds * 1000;
    await this.store.createAuthSession({
      id: crypto.randomUUID(),
      tokenHash: hashToken(token),
      userId,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
    });
    return { token, expiresAt };
  }
}

/** Map an internal user record to the safe DTO. Drops passwordHash and updatedAt. */
export function toAuthUser(user: UserRecord): AuthUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

// A throwaway hash, computed at most once per process (lazily), used to keep failed
// logins for UNKNOWN emails taking about as long as logins for known emails — blunting
// user-enumeration via a response-time side channel. The dummy password is not secret;
// its only job is to make `verifyPassword` do a real scrypt pass.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  return (dummyHashPromise ??= hashPassword('quickdrop-timing-pad-not-a-real-password'));
}
