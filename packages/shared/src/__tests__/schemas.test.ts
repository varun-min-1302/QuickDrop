import { describe, it, expect } from 'vitest';
import {
  CreateSessionResponseSchema,
  SessionStatusEnum,
  ClientJoinMessageSchema,
  ServerOfferMessageSchema,
  DataChannelFileOfferSchema,
  LIMITS,
} from '../index.js';

describe('Shared Schemas & Validation', () => {
  it('validates SessionStatusEnum properly', () => {
    expect(SessionStatusEnum.parse('CREATED')).toBe('CREATED');
    expect(SessionStatusEnum.parse('CONNECTED')).toBe('CONNECTED');
    expect(() => SessionStatusEnum.parse('INVALID_STATUS')).toThrow();
  });

  it('validates CreateSessionResponseSchema correctly', () => {
    const valid = {
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      joinToken: 'abcdef1234567890abcdef',
      numericCode: '123456',
      expiresAt: new Date().toISOString(),
      status: 'CREATED',
    };

    const parsed = CreateSessionResponseSchema.parse(valid);
    expect(parsed.sessionId).toBe(valid.sessionId);
    expect(parsed.numericCode).toBe('123456');
  });

  it('validates ClientJoinMessageSchema for customer and shop', () => {
    const customerJoin = {
      type: 'JOIN',
      role: 'customer',
      token: 'valid-token-string',
    };
    expect(ClientJoinMessageSchema.parse(customerJoin).role).toBe('customer');

    const shopJoin = {
      type: 'JOIN',
      role: 'shop',
      token: 'shop-session-token',
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
    };
    expect(ClientJoinMessageSchema.parse(shopJoin).role).toBe('shop');
  });

  it('validates ServerOfferMessageSchema', () => {
    const offer = {
      type: 'OFFER',
      sdp: {
        type: 'offer',
        sdp: 'v=0\r\no=- 20518 0 IN IP4 203.0.113.1\r\ns=\r\nt=0 0\r\n',
      },
      fromPeerId: 'shop-peer-id-123',
    };
    const parsed = ServerOfferMessageSchema.parse(offer);
    expect(parsed.fromPeerId).toBe('shop-peer-id-123');
  });

  it('validates DataChannelFileOfferSchema', () => {
    const fileOffer = {
      type: 'FILE_OFFER',
      transferId: '123e4567-e89b-12d3-a456-426614174000',
      name: 'document.pdf',
      size: 1024 * 1024,
      mime: 'application/pdf',
      totalChunks: 16,
      chunkSize: LIMITS.CHUNK_SIZE_BYTES,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    const parsed = DataChannelFileOfferSchema.parse(fileOffer);
    expect(parsed.totalChunks).toBe(16);
    expect(parsed.chunkSize).toBe(65536);
  });
});
