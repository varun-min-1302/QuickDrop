import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';
import { MemoryIdentityStore } from '../identity/index.js';
import { config } from '../config.js';

/**
 * Phase J — dedicated per-IP rate-limit buckets for the sensitive endpoints (spec §J,
 * building on the §20 auth bucket). The public customer endpoints (resolve + connect) and
 * the take-over-capable dashboard claim get tighter buckets than the global default.
 *
 * @fastify/rate-limit is skipped by default under test so suites can fire freely; these
 * tests opt in with buildApp(..., { forceRateLimit: true }) to exercise the REAL routes
 * with the REAL bucket config, and a regression test confirms the default stays off.
 */
describe('Phase J — sensitive-endpoint bucket configuration (§J)', () => {
  it('defines tighter buckets for the sensitive endpoints, below the global bucket', () => {
    expect(config.PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE).toBe(30);
    expect(config.DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE).toBe(20);
    // The whole point of a dedicated bucket: stricter than the global default.
    expect(config.PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE).toBeLessThan(config.RATE_LIMIT_MAX_PER_MINUTE);
    expect(config.DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE).toBeLessThan(config.RATE_LIMIT_MAX_PER_MINUTE);
    // Auth stays the tightest bucket (brute-force protection).
    expect(config.AUTH_RATE_LIMIT_MAX_PER_MINUTE).toBeLessThanOrEqual(
      config.DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE
    );
  });
});

describe('Phase J — buckets are enforced when the limiter is active (§J)', () => {
  let app: FastifyInstance;
  let identityStore: MemoryIdentityStore;

  beforeEach(async () => {
    identityStore = new MemoryIdentityStore();
    // Force the limiter on (default-skipped under test) with tiny sensitive buckets and a
    // generous global/auth so only the endpoint under test trips.
    const built = await buildApp(undefined, identityStore, {
      forceRateLimit: true,
      rateLimits: { global: 1000, auth: 1000, publicShop: 2, dashboardClaim: 2 },
    });
    app = built.fastify;
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  async function registerAndGetCookie(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: 'password-1234' },
    });
    expect(res.statusCode).toBe(201);
    return res.cookies.find((c) => c.name === 'qd_auth')!.value;
  }
  async function createShop(cookie: string, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/shops',
      cookies: { qd_auth: cookie },
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; publicShopId: string };
  }

  it('caps the public connect endpoint and returns the 429 envelope past the limit', async () => {
    const cookie = await registerAndGetCookie('rl-connect@shop.test');
    const shop = await createShop(cookie, 'RL Connect');
    await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/dashboard/claim`,
      cookies: { qd_auth: cookie },
      payload: { deviceLabel: 'Counter' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/shops/${shop.publicShopId}/sessions`,
      cookies: { qd_auth: cookie },
      payload: {},
    });

    const url = `/api/public/shops/${shop.publicShopId}/connect`;
    const r1 = await app.inject({ method: 'POST', url });
    const r2 = await app.inject({ method: 'POST', url });
    const r3 = await app.inject({ method: 'POST', url });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error).toBe('Too Many Requests');
  });

  it('caps the public resolve endpoint with its own counter, independent of connect', async () => {
    const cookie = await registerAndGetCookie('rl-resolve@shop.test');
    const shop = await createShop(cookie, 'RL Resolve');

    const url = `/api/public/shops/${shop.publicShopId}`;
    const r1 = await app.inject({ method: 'GET', url });
    const r2 = await app.inject({ method: 'GET', url });
    const r3 = await app.inject({ method: 'GET', url });

    // Connect was never called, so resolve's counter is what trips — proving the buckets
    // are per-route rather than a single shared public counter.
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error).toBe('Too Many Requests');
  });

  it('caps the dashboard claim / take-over endpoint', async () => {
    const cookie = await registerAndGetCookie('rl-claim@shop.test');
    const shop = await createShop(cookie, 'RL Claim');

    const url = `/api/shops/${shop.publicShopId}/dashboard/claim`;
    const opts = {
      method: 'POST' as const,
      url,
      cookies: { qd_auth: cookie },
      payload: { deviceLabel: 'Counter' },
    };
    const r1 = await app.inject(opts);
    const r2 = await app.inject(opts);
    const r3 = await app.inject(opts);

    // The limiter runs before the handler, so the third request is refused regardless of
    // the claim's business outcome (200 for the first claim, 409 for a re-claim, etc.).
    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    expect(r3.statusCode).toBe(429);
    expect(r3.json().error).toBe('Too Many Requests');
  });
});

describe('Phase J — rate limiting stays disabled by default under test (regression)', () => {
  it('does not 429 legitimate repeated traffic when not forced on', async () => {
    const identityStore = new MemoryIdentityStore();
    const built = await buildApp(undefined, identityStore);
    const app = built.fastify;
    await app.ready();
    try {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { email: 'rl-default@shop.test', password: 'password-1234' },
      });
      const cookie = reg.cookies.find((c) => c.name === 'qd_auth')!.value;
      const shop = (
        await app.inject({
          method: 'POST',
          url: '/api/shops',
          cookies: { qd_auth: cookie },
          payload: { name: 'No Limit' },
        })
      ).json() as { publicShopId: string };

      // Far more requests than any bucket would allow — all succeed because, without the
      // opt-in, the limiter plugin is skipped under test.
      for (let i = 0; i < 40; i++) {
        const res = await app.inject({ method: 'GET', url: `/api/public/shops/${shop.publicShopId}` });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
