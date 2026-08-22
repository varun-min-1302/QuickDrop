import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { MemoryIdentityStore } from '../identity/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

describe('password hashing (scrypt)', () => {
  it('produces a self-describing scrypt hash that never contains the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cret-password');
    expect(await verifyPassword('s3cret-password', hash)).toBe(true);
    expect(await verifyPassword('s3cret-passWORD', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a different hash each time (random salt) but both verify', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toEqual(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('returns false (never throws) on malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$8$1$zz$zz')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('auth routes (§7–§9)', () => {
  let app: FastifyInstance;
  let identityStore: MemoryIdentityStore;

  beforeEach(async () => {
    identityStore = new MemoryIdentityStore();
    const built = await buildApp(undefined, identityStore);
    app = built.fastify;
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  const EMAIL = 'owner@shop.test';
  const PASSWORD = 'hunter2-hunter2';

  function cookieValue(res: Awaited<ReturnType<FastifyInstance['inject']>>): string | undefined {
    return res.cookies.find((c) => c.name === 'qd_auth')?.value;
  }

  async function register(email = EMAIL, password = PASSWORD) {
    return app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password } });
  }

  it('registers an owner, sets an HttpOnly cookie, and returns only the safe user shape', async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body).toEqual({
      authenticated: true,
      user: { id: expect.any(String), email: EMAIL, createdAt: expect.any(Number) },
    });
    // No secret material anywhere in the response body.
    expect(res.payload).not.toContain(PASSWORD);
    expect(res.payload.toLowerCase()).not.toContain('passwordhash');
    expect(res.payload).not.toContain('scrypt$');

    // Cookie is present and HttpOnly (not readable by JS). Secure is off under test (HTTP).
    const cookie = res.cookies.find((c) => c.name === 'qd_auth');
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.value).toBeTruthy();
  });

  it('stores only a scrypt hash of the password, never the plaintext', async () => {
    await register();
    const stored = await identityStore.getUserByEmail(EMAIL);
    expect(stored).not.toBeNull();
    expect(stored?.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
  });

  it('rejects a duplicate email with 409', async () => {
    await register();
    const res = await register();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('EMAIL_IN_USE');
  });

  it('rejects a weak password / invalid email with 400', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: EMAIL, password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe('INVALID_REQUEST');

    const badEmail = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'not-an-email', password: PASSWORD },
    });
    expect(badEmail.statusCode).toBe(400);
  });

  it('logs in with correct credentials and rejects wrong password / unknown email identically', async () => {
    await register();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().authenticated).toBe(true);
    expect(cookieValue(ok)).toBeTruthy();

    const wrongPw = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, password: 'wrong-password' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongPw.json().error).toBe('INVALID_CREDENTIALS');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@shop.test', password: PASSWORD },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error).toBe('INVALID_CREDENTIALS');
  });

  it('GET /auth/me is anonymous-safe and reflects the session cookie', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json()).toEqual({ authenticated: false });

    const reg = await register();
    const cookie = cookieValue(reg)!;
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { qd_auth: cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      authenticated: true,
      user: { id: expect.any(String), email: EMAIL, createdAt: expect.any(Number) },
    });
  });

  it('logout revokes the session server-side so the old cookie no longer authenticates', async () => {
    const reg = await register();
    const cookie = cookieValue(reg)!;

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { qd_auth: cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ success: true });

    // Replaying the exact same (still validly-signed) cookie must now fail —
    // proving revocation is server-side, not just a client cookie clear.
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { qd_auth: cookie },
    });
    expect(me.json()).toEqual({ authenticated: false });
  });

  it('rejects a forged/garbage cookie value (signature check)', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { qd_auth: 'totally-made-up-token' },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ authenticated: false });
  });
});
