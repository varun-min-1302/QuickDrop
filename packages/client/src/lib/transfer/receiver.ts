import {
  DataChannelControlMessage,
  DataChannelFileOffer,
  TransferProgress,
} from '@quickdrop/shared';
import { decodeChunkPacket } from './protocol.js';
import { computeSHA256 } from './hashing.js';
import { transferTimings } from './timings.js';

export interface ReceivedDocument {
  /**
   * Durable per-document key, derived from the transferId so it is stable and
   * idempotent: re-finalizing the same transfer can never produce a second
   * document. Documents are stored in a Map under this id, never by array index.
   */
  documentId: string;
  transferId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  file: File;
  objectUrl: string;
  receivedAt: Date;
  /** Terminal state of the document as far as the shop is concerned. */
  status: 'RECEIVED';
}

export interface FileReceiverCallbacks {
  onProgress?: (progress: TransferProgress) => void;
  onFileReceived?: (document: ReceivedDocument) => void;
  onFileOffer?: (offer: DataChannelFileOffer, accept: () => void, wait: () => void) => void;
  onError?: (transferId: string, error: string) => void;
}

interface ActiveIncomingTransfer {
  meta: DataChannelFileOffer;
  chunks: (Uint8Array | null)[];
  receivedBytes: number;
  receivedChunksCount: number;
  startTime: number;
  lastProgressUpdate: number;
  /** True once finalizeTransfer() has begun, so FILE_END can't run twice. */
  isFinalizing: boolean;
}

export class FileReceiver {
  private channel: RTCDataChannel;
  private callbacks: FileReceiverCallbacks;
  private activeTransfers = new Map<string, ActiveIncomingTransfer>();
  /**
   * transferIds that have already reached a terminal state (completed, rejected,
   * cancelled, corrupted). A duplicate FILE_END / TRANSFER_CANCEL / FILE_OFFER for
   * one of these is ignored, so the shop's queue can never be released — or a
   * document delivered — twice for the same file.
   */
  private finalizedTransfers = new Set<string>();
  private isCleanedUp = false;

  constructor(channel: RTCDataChannel, callbacks: FileReceiverCallbacks = {}) {
    this.channel = channel;
    this.callbacks = callbacks;
    this.setupChannelListener();
  }

  private setupChannelListener() {
    this.channel.onmessage = this.onChannelMessage;
  }

  private onChannelMessage = async (event: MessageEvent) => {
    if (this.isCleanedUp) return;
    if (typeof event.data === 'string') {
      this.handleControlMessage(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      await this.handleBinaryChunk(event.data);
    }
  };

  private send(msg: DataChannelControlMessage): boolean {
    if (this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.error('FileReceiver: failed to send control message:', err);
      return false;
    }
  }

  /**
   * Single terminal exit for a failed incoming transfer: mark it finalized, drop
   * its buffers, publish a FAILED progress row, and notify the owner exactly once.
   */
  private failTransfer(transferId: string, error: string, meta?: DataChannelFileOffer) {
    if (this.finalizedTransfers.has(transferId)) return;
    this.finalizedTransfers.add(transferId);
    const transfer = this.activeTransfers.get(transferId);
    this.activeTransfers.delete(transferId);

    const info = meta ?? transfer?.meta;
    if (info) {
      this.callbacks.onProgress?.({
        transferId,
        fileName: info.name,
        fileSize: info.size,
        transferredBytes: transfer?.receivedBytes ?? 0,
        percentage: 0,
        speedBytesPerSec: 0,
        estimatedRemainingSec: 0,
        status: 'FAILED',
        error,
      });
    }

    transferTimings.mark(transferId, 'failedAt');
    this.callbacks.onError?.(transferId, error);
  }

  private handleControlMessage(jsonString: string) {
    try {
      const msg = JSON.parse(jsonString) as DataChannelControlMessage;

      if (msg.type === 'FILE_OFFER') {
        // Never resurrect a transfer that already ended, and never let a repeated
        // offer wipe the buffers of one that is already in flight.
        if (this.finalizedTransfers.has(msg.transferId) || this.activeTransfers.has(msg.transferId)) {
          return;
        }

        transferTimings.start(msg.transferId, 'receiver', msg.name, msg.size);
        transferTimings.mark(msg.transferId, 'offerReceivedAt');

        const incoming: ActiveIncomingTransfer = {
          meta: msg,
          chunks: new Array(msg.totalChunks).fill(null),
          receivedBytes: 0,
          receivedChunksCount: 0,
          startTime: performance.now(),
          lastProgressUpdate: performance.now(),
          isFinalizing: false,
        };
        this.activeTransfers.set(msg.transferId, incoming);

        this.callbacks.onProgress?.({
          transferId: msg.transferId,
          fileName: msg.name,
          fileSize: msg.size,
          transferredBytes: 0,
          percentage: 0,
          speedBytesPerSec: 0,
          estimatedRemainingSec: 0,
          status: 'QUEUED',
        });

        if (this.callbacks.onFileOffer) {
          let responded = false;
          this.callbacks.onFileOffer(
            msg,
            () => {
              // accept() — grant the slot. Guarded so a queue bug can't send two
              // FILE_ACCEPTs (which would make the sender start twice). Returns
              // whether FILE_ACCEPT actually left, because a dead channel does NOT
              // throw: the queue owner needs a real signal to release the slot with,
              // or a departed customer's slot sits held until the watchdog fires.
              if (responded || this.finalizedTransfers.has(msg.transferId)) return false;
              responded = true;
              transferTimings.mark(msg.transferId, 'acceptSentAt');
              this.callbacks.onProgress?.({
                transferId: msg.transferId,
                fileName: msg.name,
                fileSize: msg.size,
                transferredBytes: 0,
                percentage: 0,
                speedBytesPerSec: 0,
                estimatedRemainingSec: 0,
                status: 'RECEIVING',
              });
              return this.send({ type: 'FILE_ACCEPT', transferId: msg.transferId });
            },
            () => {
              // wait() — tell the sender to hold. Does not close the accept path:
              // the same transfer is accepted later when its turn comes.
              if (responded) return;
              this.send({ type: 'FILE_WAITING', transferId: msg.transferId });
            }
          );
        } else {
          // Default behavior (no queue owner): accept immediately.
          transferTimings.mark(msg.transferId, 'acceptSentAt');
          this.send({ type: 'FILE_ACCEPT', transferId: msg.transferId });
        }
      } else if (msg.type === 'FILE_END') {
        transferTimings.mark(msg.transferId, 'fileEndReceivedAt');
        this.finalizeTransfer(msg.transferId);
      } else if (msg.type === 'TRANSFER_CANCEL') {
        this.failTransfer(msg.transferId, msg.reason || 'Sender cancelled transfer');
      }
    } catch (err) {
      console.error('Error handling control message:', err);
    }
  }

  private async handleBinaryChunk(buffer: ArrayBuffer) {
    const decoded = decodeChunkPacket(buffer);
    if (!decoded) return;

    const { transferId, chunkIndex, data } = decoded;
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;

    // Reject chunk index out of bounds
    if (chunkIndex >= transfer.meta.totalChunks) return;

    // Save chunk
    if (!transfer.chunks[chunkIndex]) {
      if (transfer.receivedChunksCount === 0) {
        transferTimings.mark(transferId, 'firstChunkAt');
      }
      transfer.chunks[chunkIndex] = data;
      transfer.receivedBytes += data.byteLength;
      transfer.receivedChunksCount++;
      if (transfer.receivedChunksCount === transfer.meta.totalChunks) {
        transferTimings.mark(transferId, 'lastChunkAt');
      }
    }

    const now = performance.now();
    if (now - transfer.lastProgressUpdate > 60 || transfer.receivedChunksCount === transfer.meta.totalChunks) {
      const elapsedSec = Math.max(0.01, (now - transfer.startTime) / 1000);
      const speedBytesPerSec = transfer.receivedBytes / elapsedSec;
      const remainingBytes = transfer.meta.size - transfer.receivedBytes;
      const estimatedRemainingSec = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;
      const percentage = Math.min(100, Math.round((transfer.receivedBytes / transfer.meta.size) * 100));

      this.callbacks.onProgress?.({
        transferId,
        fileName: transfer.meta.name,
        fileSize: transfer.meta.size,
        transferredBytes: transfer.receivedBytes,
        percentage,
        speedBytesPerSec,
        estimatedRemainingSec,
        status: 'RECEIVING',
      });

      transfer.lastProgressUpdate = now;
    }
  }

  private async finalizeTransfer(transferId: string) {
    if (this.finalizedTransfers.has(transferId)) return;
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;
    // A second FILE_END while the SHA-256 hash is still being computed must not
    // start a parallel verification of the same buffers.
    if (transfer.isFinalizing) return;
    transfer.isFinalizing = true;

    this.callbacks.onProgress?.({
      transferId,
      fileName: transfer.meta.name,
      fileSize: transfer.meta.size,
      transferredBytes: transfer.receivedBytes,
      percentage: 100,
      speedBytesPerSec: 0,
      estimatedRemainingSec: 0,
      status: 'VERIFYING',
    });

    try {
      // 1. Verify all chunks received
      if (transfer.receivedChunksCount !== transfer.meta.totalChunks) {
        this.send({
          type: 'TRANSFER_ACK',
          transferId,
          verified: false,
          error: `Missing chunks: received ${transfer.receivedChunksCount} of ${transfer.meta.totalChunks}`,
          protocolVersion: '1.0',
        });
        this.failTransfer(transferId, 'Transfer incomplete: missing chunks.');
        return;
      }

      // 2. Reassemble Blob from Uint8Array slices directly
      const validChunks = transfer.chunks.filter((c): c is Uint8Array => c !== null);
      const blob = new Blob(validChunks as unknown as BlobPart[], { type: transfer.meta.mime });

      // 3. Compute post-transfer SHA-256 Checksum
      transferTimings.mark(transferId, 'checksumStartAt');
      const computedHash = await computeSHA256(blob);
      transferTimings.mark(transferId, 'checksumEndAt');

      // The channel may have died while we were hashing.
      if (this.finalizedTransfers.has(transferId)) return;

      if (computedHash.toLowerCase() !== transfer.meta.sha256.toLowerCase()) {
        // Integrity check failed
        this.send({
          type: 'TRANSFER_ACK',
          transferId,
          verified: false,
          error: 'SHA-256 integrity verification failed',
          protocolVersion: '1.0',
        });
        this.failTransfer(transferId, 'Checksum mismatch - file corrupted during transfer.');
        return;
      }

      // 4. Send Success ACK to Customer
      this.send({
        type: 'TRANSFER_ACK',
        transferId,
        verified: true,
        protocolVersion: '1.0',
      });
      transferTimings.mark(transferId, 'ackSentAt');

      // 5. Create in-memory File and object URL for shop operator actions
      const file = new File([blob], transfer.meta.name, {
        type: transfer.meta.mime,
        lastModified: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);

      const receivedDoc: ReceivedDocument = {
        documentId: `doc_${transferId}`,
        transferId,
        name: transfer.meta.name,
        size: transfer.meta.size,
        mime: transfer.meta.mime,
        sha256: computedHash,
        file,
        objectUrl,
        receivedAt: new Date(),
        status: 'RECEIVED',
      };

      // Mark terminal BEFORE notifying, so a late FILE_END or TRANSFER_CANCEL that
      // lands during the callbacks below cannot re-enter any terminal path.
      this.finalizedTransfers.add(transferId);
      this.activeTransfers.delete(transferId);

      this.callbacks.onProgress?.({
        transferId,
        fileName: transfer.meta.name,
        fileSize: transfer.meta.size,
        transferredBytes: transfer.meta.size,
        percentage: 100,
        speedBytesPerSec: 0,
        estimatedRemainingSec: 0,
        status: 'COMPLETED',
      });

      transferTimings.mark(transferId, 'completedAt');
      transferTimings.report(transferId);

      this.callbacks.onFileReceived?.(receivedDoc);
    } catch (err: any) {
      console.error('Finalize transfer error:', err);
      this.failTransfer(transferId, err?.message || 'Failed to assemble file');
    }
  }

  /**
   * Tear down. Any transfer still in flight is terminal — the channel this
   * receiver was built on is gone, so no further chunk or FILE_END can arrive.
   */
  public cleanup() {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;
    if (this.channel.onmessage === this.onChannelMessage) {
      this.channel.onmessage = null;
    }
    for (const transferId of Array.from(this.activeTransfers.keys())) {
      this.failTransfer(transferId, 'Connection closed before the transfer finished.');
    }
    this.activeTransfers.clear();
    this.finalizedTransfers.clear();
  }
}
