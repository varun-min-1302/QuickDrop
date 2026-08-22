import { BINARY_HEADER_SIZE } from '@quickdrop/shared';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode a binary chunk with a 40-byte header (36 bytes UUID + 4 bytes uint32 index).
 */
export function encodeChunkPacket(transferId: string, chunkIndex: number, chunkBytes: ArrayBuffer): ArrayBuffer {
  const packet = new Uint8Array(BINARY_HEADER_SIZE + chunkBytes.byteLength);
  
  // 1. Write 36-char transferId
  const idBytes = textEncoder.encode(transferId.slice(0, 36).padEnd(36, ' '));
  packet.set(idBytes, 0);

  // 2. Write 4-byte chunk index (Big Endian)
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  view.setUint32(36, chunkIndex, false);

  // 3. Write chunk bytes
  packet.set(new Uint8Array(chunkBytes), BINARY_HEADER_SIZE);

  return packet.buffer;
}

/**
 * Decode a binary packet into its transferId, chunkIndex, and binary data slice.
 */
export function decodeChunkPacket(buffer: ArrayBuffer): {
  transferId: string;
  chunkIndex: number;
  data: Uint8Array;
} | null {
  if (buffer.byteLength < BINARY_HEADER_SIZE) return null;

  const headerBytes = new Uint8Array(buffer, 0, 36);
  const transferId = textDecoder.decode(headerBytes).trim();

  const view = new DataView(buffer, 0, BINARY_HEADER_SIZE);
  const chunkIndex = view.getUint32(36, false);

  const data = new Uint8Array(buffer, BINARY_HEADER_SIZE);

  return {
    transferId,
    chunkIndex,
    data,
  };
}
