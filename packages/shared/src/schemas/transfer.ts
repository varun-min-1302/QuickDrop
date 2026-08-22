import { z } from 'zod';
import { LIMITS, PROTOCOL_VERSION } from '../constants.js';

export const FileMetadataSchema = z.object({
  name: z.string().min(1).max(LIMITS.MAX_FILENAME_LENGTH),
  size: z.number().int().positive().max(LIMITS.MAX_FILE_SIZE_BYTES),
  mime: z.string().min(1),
  extension: z.string().min(1).max(10),
});

export type FileMetadata = z.infer<typeof FileMetadataSchema>;

export const DataChannelFileOfferSchema = z.object({
  type: z.literal('FILE_OFFER'),
  transferId: z.string().uuid(),
  name: z.string().min(1).max(LIMITS.MAX_FILENAME_LENGTH),
  size: z.number().int().positive().max(LIMITS.MAX_FILE_SIZE_BYTES),
  mime: z.string(),
  totalChunks: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  sha256: z.string().length(64),
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
});

export type DataChannelFileOffer = z.infer<typeof DataChannelFileOfferSchema>;

export const DataChannelFileAcceptSchema = z.object({
  type: z.literal('FILE_ACCEPT'),
  transferId: z.string().uuid(),
});

export type DataChannelFileAccept = z.infer<typeof DataChannelFileAcceptSchema>;

export const DataChannelFileWaitingSchema = z.object({
  type: z.literal('FILE_WAITING'),
  transferId: z.string().uuid(),
  message: z.string().optional(),
});

export type DataChannelFileWaiting = z.infer<typeof DataChannelFileWaitingSchema>;

export const DataChannelFileEndSchema = z.object({
  type: z.literal('FILE_END'),
  transferId: z.string().uuid(),
});

export type DataChannelFileEnd = z.infer<typeof DataChannelFileEndSchema>;

export const DataChannelTransferAckSchema = z.object({
  type: z.literal('TRANSFER_ACK'),
  transferId: z.string().uuid(),
  verified: z.boolean(),
  error: z.string().optional(),
  protocolVersion: z.string().optional().default(PROTOCOL_VERSION),
});

export type DataChannelTransferAck = z.infer<typeof DataChannelTransferAckSchema>;

export const DataChannelTransferCancelSchema = z.object({
  type: z.literal('TRANSFER_CANCEL'),
  transferId: z.string().uuid(),
  reason: z.string().max(200).optional(),
});

export type DataChannelTransferCancel = z.infer<typeof DataChannelTransferCancelSchema>;

export const DataChannelPingSchema = z.object({
  type: z.literal('PING'),
  timestamp: z.number(),
});

export const DataChannelPongSchema = z.object({
  type: z.literal('PONG'),
  timestamp: z.number(),
});

export const DataChannelErrorMessageSchema = z.object({
  type: z.literal('ERROR'),
  transferId: z.string().uuid().optional(),
  code: z.string(),
  message: z.string(),
});

export const DataChannelControlMessageSchema = z.discriminatedUnion('type', [
  DataChannelFileOfferSchema,
  DataChannelFileAcceptSchema,
  DataChannelFileWaitingSchema,
  DataChannelFileEndSchema,
  DataChannelTransferAckSchema,
  DataChannelTransferCancelSchema,
  DataChannelPingSchema,
  DataChannelPongSchema,
  DataChannelErrorMessageSchema,
]);

export type DataChannelControlMessage = z.infer<typeof DataChannelControlMessageSchema>;

export interface TransferProgress {
  transferId: string;
  fileName: string;
  fileSize: number;
  transferredBytes: number;
  percentage: number;
  speedBytesPerSec: number;
  estimatedRemainingSec: number;
  status: 'QUEUED' | 'HASHING' | 'SENDING' | 'RECEIVING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error?: string;
}

export const BINARY_HEADER_SIZE = 40; // 36 bytes transferId UUID + 4 bytes uint32 chunk index
