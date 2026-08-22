import { z } from 'zod';

/**
 * Shop identity + membership + dashboard-device DTOs.
 *
 * The `publicShopId` is a PUBLIC REFERENCE, not a credential (spec §3): it is safe
 * to embed in the printed QR, but it grants no dashboard access on its own. Every
 * shop-management API still requires an authenticated owner session and a verified
 * membership. Secret-bearing internal entities live server-side, not here.
 */

/** MVP implements OWNER only; the rest are reserved so the model stays extensible (§3). */
export const ShopRoleEnum = z.enum(['OWNER', 'ADMIN', 'STAFF', 'COUNTER_OPERATOR']);
export type ShopRole = z.infer<typeof ShopRoleEnum>;

export const ShopStatusEnum = z.enum(['ACTIVE', 'SUSPENDED']);
export type ShopStatus = z.infer<typeof ShopStatusEnum>;

export const DashboardDeviceStatusEnum = z.enum(['ACTIVE', 'REVOKED']);
export type DashboardDeviceStatus = z.infer<typeof DashboardDeviceStatusEnum>;

/**
 * publicShopId format: `QD-` + 6 chars from an unambiguous alphabet (no 0/O/1/I),
 * matching the alphabet used for numeric backup codes. Example: `QD-7F82A9`.
 */
export const PUBLIC_SHOP_ID_PREFIX = 'QD-';
export const PUBLIC_SHOP_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PUBLIC_SHOP_ID_BODY_LENGTH = 6;
export const PUBLIC_SHOP_ID_REGEX = /^QD-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export const PublicShopIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PUBLIC_SHOP_ID_REGEX, { message: 'Invalid shop code.' });

/** POST /api/shops — create the permanent shop during onboarding (§5). */
export const CreateShopRequestSchema = z.object({
  name: z.string().trim().min(1, { message: 'Shop name is required.' }).max(80),
});
export type CreateShopRequest = z.infer<typeof CreateShopRequestSchema>;

/**
 * Owner-facing shop summary (dashboard / settings). Safe to return to the
 * authenticated owner. Contains the permanent identity but no secrets.
 */
export const ShopSummarySchema = z.object({
  id: z.string().uuid(),
  publicShopId: PublicShopIdSchema,
  name: z.string(),
  status: ShopStatusEnum,
  role: ShopRoleEnum,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ShopSummary = z.infer<typeof ShopSummarySchema>;

/**
 * Customer-facing resolution of a scanned QR (§4/§14). Deliberately minimal — it
 * reveals only what a walk-in customer needs (shop name + whether it is online).
 * It never exposes owner identity, membership, or any other private shop.
 */
export const PublicShopResolveResponseSchema = z.object({
  publicShopId: PublicShopIdSchema,
  name: z.string(),
  online: z.boolean(),
});
export type PublicShopResolveResponse = z.infer<typeof PublicShopResolveResponseSchema>;

/**
 * Customer-facing bridge result (spec §16): the permanent QR (publicShopId) resolved
 * to the shop's CURRENT temporary transfer session. Returns only what a customer needs
 * to join — the numericCode is that session's existing customer-join credential, and
 * expiresAt drives the client countdown. Never exposes a raw joinToken (the server
 * only holds its hash) nor any owner/private data. Available only while the shop is
 * online and has a live session; otherwise the endpoint returns 404/409, not this body.
 */
export const PublicShopConnectResponseSchema = z.object({
  publicShopId: PublicShopIdSchema,
  name: z.string(),
  sessionId: z.string().uuid(),
  numericCode: z.string().length(6),
  expiresAt: z.number(),
});
export type PublicShopConnectResponse = z.infer<typeof PublicShopConnectResponseSchema>;

/** A dashboard device as shown in shop settings (§21) / take-over UI (§11). */
export const DashboardDeviceSummarySchema = z.object({
  id: z.string().uuid(),
  deviceLabel: z.string(),
  connectedAt: z.number(),
  lastSeenAt: z.number(),
  status: DashboardDeviceStatusEnum,
  /** True if this row is the caller's own current dashboard device. */
  current: z.boolean(),
});
export type DashboardDeviceSummary = z.infer<typeof DashboardDeviceSummarySchema>;

/**
 * POST /api/shops/:publicShopId/dashboard/claim — attempt to become the ONE active
 * dashboard device for the shop (§11/§12). When another device already holds it and
 * `takeOver` is not set, the server responds 409 with `alreadyActive` details.
 */
export const ClaimDashboardRequestSchema = z.object({
  /** When true, forcibly revoke the current active device and take over (§11). */
  takeOver: z.boolean().optional().default(false),
  /** Optional human-friendly device label; server falls back to a UA-derived one. */
  deviceLabel: z.string().trim().max(80).optional(),
});
export type ClaimDashboardRequest = z.infer<typeof ClaimDashboardRequestSchema>;

export const ClaimDashboardResponseSchema = z.object({
  deviceSessionId: z.string().uuid(),
  shop: ShopSummarySchema,
});
export type ClaimDashboardResponse = z.infer<typeof ClaimDashboardResponseSchema>;

/** 409 body when a different device already owns the dashboard (§11). */
export const DashboardConflictResponseSchema = z.object({
  error: z.literal('DASHBOARD_ALREADY_ACTIVE'),
  message: z.string(),
  activeDevice: z.object({
    deviceLabel: z.string(),
    connectedAt: z.number(),
    lastSeenAt: z.number(),
  }),
});
export type DashboardConflictResponse = z.infer<typeof DashboardConflictResponseSchema>;
