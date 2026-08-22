import { z } from 'zod';
import { PROTOCOL_VERSION } from '../constants.js';

export const IceServerConfigSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type IceServerConfig = z.infer<typeof IceServerConfigSchema>;

export const RTCSessionDescriptionInitSchema = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: z.string(),
});

export const RTCIceCandidateInitSchema = z.object({
  candidate: z.string().optional().default(''),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

// Client -> Server Messages
export const ClientJoinMessageSchema = z.object({
  type: z.literal('JOIN'),
  role: z.enum(['shop', 'customer']),
  // Optional: a customer arriving via the permanent-QR bridge (§16) joins with only the
  // session's numericCode — the server never vends a raw joinToken (it holds only the
  // hash). Shops and legacy customers still join with the raw token. At least one of
  // token / numericCode / sessionId must be present, enforced in the JOIN handler
  // (a refine() here would turn this into a ZodEffects and break the discriminatedUnion).
  token: z.string().min(1).optional(),
  sessionId: z.string().uuid().optional(),
  numericCode: z.string().optional(),
  clientId: z.string().max(100).optional(),
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
});

export const ClientOfferMessageSchema = z.object({
  type: z.literal('OFFER'),
  sdp: RTCSessionDescriptionInitSchema,
  targetPeerId: z.string().optional(),
});

export const ClientAnswerMessageSchema = z.object({
  type: z.literal('ANSWER'),
  sdp: RTCSessionDescriptionInitSchema,
  targetPeerId: z.string().optional(),
});

export const ClientIceCandidateMessageSchema = z.object({
  type: z.literal('ICE_CANDIDATE'),
  candidate: RTCIceCandidateInitSchema,
  targetPeerId: z.string().optional(),
});

export const ClientLeaveMessageSchema = z.object({
  type: z.literal('LEAVE'),
  reason: z.string().max(100).optional(),
});

export const ClientPingMessageSchema = z.object({
  type: z.literal('PING'),
});

export const ClientCustomerUpdatedMessageSchema = z.object({
  type: z.literal('CUSTOMER_UPDATED'),
  displayName: z.string().max(50).nullable(),
});

export const ClientBatchCompletedMessageSchema = z.object({
  type: z.literal('BATCH_COMPLETED'),
});

export const ClientSignalingMessageSchema = z.discriminatedUnion('type', [
  ClientJoinMessageSchema,
  ClientOfferMessageSchema,
  ClientAnswerMessageSchema,
  ClientIceCandidateMessageSchema,
  ClientLeaveMessageSchema,
  ClientPingMessageSchema,
  ClientCustomerUpdatedMessageSchema,
  ClientBatchCompletedMessageSchema,
]);

export type ClientSignalingMessage = z.infer<typeof ClientSignalingMessageSchema>;

// Server -> Client Messages
export const ServerJoinAcceptedMessageSchema = z.object({
  type: z.literal('JOIN_ACCEPTED'),
  sessionId: z.string().uuid(),
  role: z.enum(['shop', 'customer']),
  peerId: z.string(),
  iceServers: z.array(IceServerConfigSchema),
  expiresAt: z.number(),
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
  customerCode: z.string().optional(),
  batchId: z.string().optional(),
});

export const ServerJoinRejectedMessageSchema = z.object({
  type: z.literal('JOIN_REJECTED'),
  reason: z.string(),
  code: z.enum(['SESSION_NOT_FOUND', 'SESSION_EXPIRED', 'SESSION_OCCUPIED', 'RATE_LIMITED', 'INVALID_TOKEN']),
});

export const ServerPeerJoinedMessageSchema = z.object({
  type: z.literal('PEER_JOINED'),
  peerId: z.string(),
  role: z.enum(['shop', 'customer']),
  customer: z.object({
    clientId: z.string(),
    customerCode: z.string(),
    displayName: z.string().nullable().optional(),
    batchId: z.string(),
  }).optional(),
});

export const ServerPeerLeftMessageSchema = z.object({
  type: z.literal('PEER_LEFT'),
  peerId: z.string(),
  role: z.enum(['shop', 'customer']),
  clientId: z.string().optional(), // Provided when role is 'customer'
});

export const ServerCustomerUpdatedMessageSchema = z.object({
  type: z.literal('CUSTOMER_UPDATED'),
  peerId: z.string(),
  clientId: z.string(),
  displayName: z.string().nullable(),
});

export const ServerBatchCompletedMessageSchema = z.object({
  type: z.literal('BATCH_COMPLETED'),
  peerId: z.string(),
  clientId: z.string(),
});

export const ServerOfferMessageSchema = z.object({
  type: z.literal('OFFER'),
  sdp: RTCSessionDescriptionInitSchema,
  fromPeerId: z.string(),
});

export const ServerAnswerMessageSchema = z.object({
  type: z.literal('ANSWER'),
  sdp: RTCSessionDescriptionInitSchema,
  fromPeerId: z.string(),
});

export const ServerIceCandidateMessageSchema = z.object({
  type: z.literal('ICE_CANDIDATE'),
  candidate: RTCIceCandidateInitSchema,
  fromPeerId: z.string(),
});

export const ServerSessionExpiredMessageSchema = z.object({
  type: z.literal('SESSION_EXPIRED'),
  reason: z.string().optional(),
});

export const ServerSessionClosedMessageSchema = z.object({
  type: z.literal('SESSION_CLOSED'),
  reason: z.string().optional(),
});

export const ServerErrorMessageSchema = z.object({
  type: z.literal('ERROR'),
  code: z.string(),
  message: z.string(),
});

export const ServerPongMessageSchema = z.object({
  type: z.literal('PONG'),
});

export const ServerSignalingMessageSchema = z.discriminatedUnion('type', [
  ServerJoinAcceptedMessageSchema,
  ServerJoinRejectedMessageSchema,
  ServerPeerJoinedMessageSchema,
  ServerPeerLeftMessageSchema,
  ServerCustomerUpdatedMessageSchema,
  ServerBatchCompletedMessageSchema,
  ServerOfferMessageSchema,
  ServerAnswerMessageSchema,
  ServerIceCandidateMessageSchema,
  ServerSessionExpiredMessageSchema,
  ServerSessionClosedMessageSchema,
  ServerErrorMessageSchema,
  ServerPongMessageSchema,
]);

export type ServerSignalingMessage = z.infer<typeof ServerSignalingMessageSchema>;
