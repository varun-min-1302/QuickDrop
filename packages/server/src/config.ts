import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173'),
  REDIS_URL: z.string().optional(),
  SESSION_TTL_SECONDS: z.coerce.number().default(900), // 15 minutes
  // ── Permanent shop identity + owner auth (persistent, NOT ephemeral) ──────────
  /** SQLite file holding users/shops/memberships/device-sessions/auth-sessions. */
  IDENTITY_DB_PATH: z.string().default('./data/quickdrop.db'),
  /** Secret used to sign the HttpOnly auth cookie. Enforced-present in production. */
  COOKIE_SECRET: z.string().optional(),
  /** Owner login session lifetime. Default 30 days. */
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().default(30 * 24 * 60 * 60),
  /** Per-IP login attempts per minute (brute-force protection, §20). */
  AUTH_RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(10),
  /** A shop counts as "online" if its active dashboard device was seen this recently (§15). */
  DASHBOARD_PRESENCE_TTL_SECONDS: z.coerce.number().default(60),
  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(120),
  /**
   * Per-IP requests/minute for the public, unauthenticated customer shop endpoints —
   * GET /api/public/shops/:publicShopId (resolve) and POST .../connect (bridge). Tighter
   * than the global bucket to blunt shop-code scraping and connect spam (§16, §J).
   */
  PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(30),
  /**
   * Per-IP requests/minute for dashboard claim / take-over. A claim with takeOver can
   * evict the active device, so this sensitive endpoint gets its own tight bucket (§11, §J).
   */
  DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().default(20),
  MAX_WEBSOCKET_MESSAGE_BYTES: z.coerce.number().default(64 * 1024), // 64 KiB
  MAX_WEBSOCKET_MESSAGES_PER_WINDOW: z.coerce.number().default(60), // max 60 msgs / 10 sec window
  STUN_SERVERS: z.string().default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  TURN_SERVER_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config = ConfigSchema.parse({
  PORT: process.env.PORT,
  HOST: process.env.HOST,
  NODE_ENV: process.env.NODE_ENV,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  REDIS_URL: process.env.REDIS_URL,
  SESSION_TTL_SECONDS: process.env.SESSION_TTL_SECONDS,
  IDENTITY_DB_PATH: process.env.IDENTITY_DB_PATH,
  COOKIE_SECRET: process.env.COOKIE_SECRET,
  AUTH_SESSION_TTL_SECONDS: process.env.AUTH_SESSION_TTL_SECONDS,
  AUTH_RATE_LIMIT_MAX_PER_MINUTE: process.env.AUTH_RATE_LIMIT_MAX_PER_MINUTE,
  DASHBOARD_PRESENCE_TTL_SECONDS: process.env.DASHBOARD_PRESENCE_TTL_SECONDS,
  RATE_LIMIT_MAX_PER_MINUTE: process.env.RATE_LIMIT_MAX_PER_MINUTE,
  PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE: process.env.PUBLIC_SHOP_RATE_LIMIT_MAX_PER_MINUTE,
  DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE: process.env.DASHBOARD_CLAIM_RATE_LIMIT_MAX_PER_MINUTE,
  MAX_WEBSOCKET_MESSAGE_BYTES: process.env.MAX_WEBSOCKET_MESSAGE_BYTES,
  MAX_WEBSOCKET_MESSAGES_PER_WINDOW: process.env.MAX_WEBSOCKET_MESSAGES_PER_WINDOW,
  STUN_SERVERS: process.env.STUN_SERVERS,
  TURN_SERVER_URL: process.env.TURN_SERVER_URL,
  TURN_USERNAME: process.env.TURN_USERNAME,
  TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
});

export function getIceServers() {
  const stunUrls = config.STUN_SERVERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: stunUrls },
  ];

  if (config.TURN_SERVER_URL && config.TURN_USERNAME && config.TURN_CREDENTIAL) {
    iceServers.push({
      urls: config.TURN_SERVER_URL,
      username: config.TURN_USERNAME,
      credential: config.TURN_CREDENTIAL,
    });
  }

  return iceServers;
}
