import { z } from 'zod';
import { LIMITS, PROTOCOL_VERSION } from '../constants.js';

export const SessionStatusEnum = z.enum([
  'CREATED',
  'CONNECTED',
  'TRANSFERRING',
  'READY',
  'CLOSED',
  'EXPIRED',
]);

export type SessionStatus = z.infer<typeof SessionStatusEnum>;

export const CreateSessionRequestSchema = z.object({
  shopName: z.string().max(50).optional(),
  ttlSeconds: z.number().int().min(60).max(3600).default(LIMITS.DEFAULT_SESSION_TTL_SECONDS),
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  joinToken: z.string().min(16),
  numericCode: z.string().length(6),
  expiresAt: z.string().datetime(),
  status: SessionStatusEnum,
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
});

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const SessionStatusResponseSchema = z.object({
  sessionId: z.string().uuid(),
  status: SessionStatusEnum,
  hasShop: z.boolean(),
  customerCount: z.number().nonnegative(),
  expiresAt: z.string().datetime(),
  remainingSeconds: z.number().nonnegative(),
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
});

export type SessionStatusResponse = z.infer<typeof SessionStatusResponseSchema>;

export const SessionMetadataSchema = z.object({
  sessionId: z.string().uuid(),
  tokenHash: z.string(),
  numericCode: z.string().length(6),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: SessionStatusEnum,
  shopConnectionId: z.string().optional(),
  customerCount: z.number().default(0),
  shopName: z.string().optional(),
  /**
   * Permanent shop this transfer session belongs to (spec §16 bridge). Present only
   * for sessions created via the authenticated shop-scoped endpoint; absent for the
   * legacy anonymous `POST /api/sessions` path. Links the ephemeral session back to
   * the durable shop identity without storing any document bytes.
   */
  shopId: z.string().uuid().optional(),
  totalTransferredBytes: z.number().default(0),
  fileCount: z.number().default(0),
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
});

export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;
