import { LIMITS, TransferProgress, DataChannelControlMessage } from '@quickdrop/shared';
import { computeSHA256 } from './hashing.js';
import { encodeChunkPacket } from './protocol.js';
import { sanitizeFilename } from './sanitizer.js';
import { transferTimings } from './timings.js';

export interface FileSenderCallbacks {
  onProgress?: (progress: TransferProgress) => void;
  onComplete?: (transferId: string) => void;
  onError?: (err: Error) => void;
  onStatusChange?: (status: TransferProgress['status']) => void;
}

export interface FileSenderOptions {
  /** How long to wait for the shop's TRANSFER_ACK after FILE_END. */
  ackTimeoutMs?: number;
  /** How long to wait in the shop's queue for FILE_ACCEPT. */
  acceptTimeoutMs?: number;
  /** How long to wait for the send buffer to drain before declaring the link dead. */
  bufferDrainTimeoutMs?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

const DEFAULTS = {
  ackTimeoutMs: 30_000,
  acceptTimeoutMs: 600_000,
  bufferDrainTimeoutMs: 30_000,
} as const;

/**
 * Sends exactly one file over an open DataChannel.
 *
 * One FileSender owns one transferId and one set of listeners/timers, and every
 * exit path runs through `dispose()`. That isolation is what keeps a failed file
 * from corrupting the next one: a stale ACK for file A can never be observed by
 * file B's sender, because A's listener is gone before B's is installed.
 */
export class FileSender {
  public transferId: string;
  public file: File;
  public isCancelled = false;
  /** True only after the shop returned a verified TRANSFER_ACK. */
  public wasCompleted = false;

  private channel: RTCDataChannel;
  private callbacks: FileSenderCallbacks;
  private opts: Required<FileSenderOptions>;

  private hasStarted = false;
  private isDisposed = false;
  /** Latest real byte count, so status changes don't reset the progress bar to 0. */
  private transferredBytes = 0;
  private safeName: string;
  /** The shop already declared this transfer dead — don't send it a cancel back. */
  private shopDeclaredTerminal = false;
  private isAccepted = false;

  private acceptWaiter: Waiter | null = null;
  private ackWaiter: Waiter | null = null;
  /** A settlement that arrived before anything was waiting for it. */
  private earlyAccept: Error | 'ok' | null = null;
  private earlyAck: Error | 'ok' | null = null;

  private timers = new Set<ReturnType<typeof setTimeout>>();
  private bufferDrainListener: (() => void) | null = null;

  constructor(
    file: File,
    channel: RTCDataChannel,
    callbacks: FileSenderCallbacks = {},
    options: FileSenderOptions = {},
  ) {
    this.file = file;
    this.channel = channel;
    this.callbacks = callbacks;
    this.transferId = crypto.randomUUID();
    this.safeName = sanitizeFilename(file.name);
    this.opts = {
      ackTimeoutMs: options.ackTimeoutMs ?? DEFAULTS.ackTimeoutMs,
      acceptTimeoutMs: options.acceptTimeoutMs ?? DEFAULTS.acceptTimeoutMs,
      bufferDrainTimeoutMs: options.bufferDrainTimeoutMs ?? DEFAULTS.bufferDrainTimeoutMs,
    };
  }

  // ─── Timers ─────────────────────────────────────────────────────────────────

  private addTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  // ─── Single channel listener, routed to whoever is waiting ───────────────────

  private onChannelMessage = (event: MessageEvent) => {
    if (this.isDisposed) return;
    if (typeof event.data !== 'string') return;

    let msg: DataChannelControlMessage;
    try {
      msg = JSON.parse(event.data) as DataChannelControlMessage;
    } catch {
      return;
    }

    // Strict correlation: anything not addressed to THIS transferId is ignored, so
    // a late ACK for a previous file can never finalize this one.
    if (!('transferId' in msg) || msg.transferId !== this.transferId) return;

    switch (msg.type) {
      case 'FILE_ACCEPT':
        transferTimings.mark(this.transferId, 'acceptReceivedAt');
        this.isAccepted = true;
        this.settleAccept('ok');
        break;

      case 'FILE_WAITING':
        // Still sitting in the shop's queue — keep the UI honest.
        if (!this.isAccepted) this.callbacks.onStatusChange?.('QUEUED');
        break;

      case 'TRANSFER_ACK':
        transferTimings.mark(this.transferId, 'ackReceivedAt');
        if (msg.verified) {
          this.settleAck('ok');
        } else {
          this.shopDeclaredTerminal = true;
          this.settleAck(new Error(msg.error || 'Shop checksum verification failed.'));
        }
        break;

      case 'TRANSFER_CANCEL': {
        this.shopDeclaredTerminal = true;
        const err = new Error(msg.reason || 'Transfer cancelled by the shop.');
        this.settleAccept(err);
        this.settleAck(err);
        break;
      }

      case 'ERROR': {
        this.shopDeclaredTerminal = true;
        const err = new Error(msg.message || 'The shop reported an error.');
        this.settleAccept(err);
        this.settleAck(err);
        break;
      }
    }
  };

  private settleAccept(result: Error | 'ok') {
    const waiter = this.acceptWaiter;
    if (!waiter) {
      if (this.earlyAccept === null) this.earlyAccept = result;
      return;
    }
    this.acceptWaiter = null;
    if (result === 'ok') waiter.resolve();
    else waiter.reject(result);
  }

  private settleAck(result: Error | 'ok') {
    const waiter = this.ackWaiter;
    if (!waiter) {
      if (this.earlyAck === null) this.earlyAck = result;
      return;
    }
    this.ackWaiter = null;
    if (result === 'ok') waiter.resolve();
    else waiter.reject(result);
  }

  /**
   * Removes every listener and timer this sender owns. Idempotent, and runs on
   * every exit path (success, failure, cancel) — nothing is left armed.
   */
  private dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.clearTimers();
    try {
      this.channel.removeEventListener('message', this.onChannelMessage);
    } catch {}
    if (this.bufferDrainListener) {
      try {
        this.channel.removeEventListener('bufferedamountlow', this.bufferDrainListener);
      } catch {}
      this.bufferDrainListener = null;
    }
    // Anything still awaiting would otherwise hang forever.
    this.settleAccept(new Error('Transfer ended.'));
    this.settleAck(new Error('Transfer ended.'));
    this.acceptWaiter = null;
    this.ackWaiter = null;
  }

  // ─── Main flow ──────────────────────────────────────────────────────────────

  public async start(): Promise<void> {
    if (this.hasStarted) return;
    this.hasStarted = true;

    transferTimings.start(this.transferId, 'sender', this.safeName, this.file.size);
    this.channel.addEventListener('message', this.onChannelMessage);

    try {
      this.assertChannelOpen();
      this.updateStatus('HASHING');

      // 1. Compute pre-transfer SHA-256 checksum
      transferTimings.mark(this.transferId, 'hashStartAt');
      const sha256 = await computeSHA256(this.file);
      transferTimings.mark(this.transferId, 'hashEndAt');
      if (this.isCancelled) return;

      const totalChunks = Math.ceil(this.file.size / LIMITS.CHUNK_SIZE_BYTES);

      // 2. Send FILE_OFFER control packet
      this.assertChannelOpen();
      const fileStartMsg: DataChannelControlMessage = {
        type: 'FILE_OFFER',
        transferId: this.transferId,
        name: this.safeName,
        size: this.file.size,
        mime: this.file.type || 'application/octet-stream',
        totalChunks,
        chunkSize: LIMITS.CHUNK_SIZE_BYTES,
        sha256,
        protocolVersion: '1.0',
      };
      this.channel.send(JSON.stringify(fileStartMsg));
      transferTimings.mark(this.transferId, 'offerSentAt');

      this.updateStatus('QUEUED');
      await this.waitForAccept();
      if (this.isCancelled) return;
      this.updateStatus('SENDING');

      // Arm the ACK waiter before the first byte leaves, so a very fast shop can't
      // ACK into a void.
      const ackPromise = this.waitForAck();
      // The rejection is consumed by the `await` below; attaching a no-op catch
      // keeps Node/browser from reporting it as unhandled if we throw earlier.
      ackPromise.catch(() => {});

      // 3. Chunk Streaming Loop with Backpressure
      const startTime = performance.now();
      let lastProgressUpdate = performance.now();

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (this.isCancelled) {
          this.sendCancel('Transfer cancelled by user');
          return;
        }
        this.assertChannelOpen();

        // Apply backpressure if buffer is full
        if (this.channel.bufferedAmount > LIMITS.BUFFERED_AMOUNT_HIGH_WATERMARK) {
          await this.waitForBufferDrain();
          if (this.isCancelled) return;
          this.assertChannelOpen();
        }

        const startByte = chunkIndex * LIMITS.CHUNK_SIZE_BYTES;
        const endByte = Math.min(this.file.size, startByte + LIMITS.CHUNK_SIZE_BYTES);
        const slice = this.file.slice(startByte, endByte);
        const chunkBuffer = await slice.arrayBuffer();

        const packet = encodeChunkPacket(this.transferId, chunkIndex, chunkBuffer);
        this.channel.send(packet);
        if (chunkIndex === 0) transferTimings.mark(this.transferId, 'firstChunkSentAt');

        this.transferredBytes += chunkBuffer.byteLength;

        // Throttle UI progress updates to avoid React render churn (every 60ms or at completion)
        const now = performance.now();
        if (now - lastProgressUpdate > 60 || chunkIndex === totalChunks - 1) {
          const elapsedSec = Math.max(0.01, (now - startTime) / 1000);
          const speedBytesPerSec = this.transferredBytes / elapsedSec;
          const remainingBytes = this.file.size - this.transferredBytes;
          const estimatedRemainingSec = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;
          const percentage = Math.min(100, Math.round((this.transferredBytes / this.file.size) * 100));

          this.callbacks.onProgress?.({
            transferId: this.transferId,
            fileName: this.safeName,
            fileSize: this.file.size,
            transferredBytes: this.transferredBytes,
            percentage,
            speedBytesPerSec,
            estimatedRemainingSec,
            status: 'SENDING',
          });

          lastProgressUpdate = now;
        }
      }
      transferTimings.mark(this.transferId, 'lastChunkSentAt');

      // 4. Send FILE_END control packet
      this.assertChannelOpen();
      const fileEndMsg: DataChannelControlMessage = {
        type: 'FILE_END',
        transferId: this.transferId,
      };
      this.channel.send(JSON.stringify(fileEndMsg));
      transferTimings.mark(this.transferId, 'fileEndSentAt');

      this.updateStatus('VERIFYING');

      // 5. Wait for Shop ACK with SHA-256 verification
      await ackPromise;
      if (this.isCancelled) return;

      transferTimings.mark(this.transferId, 'completedAt');
      this.wasCompleted = true;
      this.updateStatus('COMPLETED');
      this.callbacks.onComplete?.(this.transferId);
    } catch (err: any) {
      transferTimings.mark(this.transferId, 'failedAt');
      if (!this.isCancelled) {
        // Tell the shop this file is dead so it releases its queue slot and lets
        // the next file through. Without this, a sender-side timeout (e.g. the ACK
        // never arriving) left the shop holding its only slot forever and every
        // later file sat in "Waiting in Queue" indefinitely.
        if (!this.shopDeclaredTerminal) {
          this.sendCancel(err?.message ? `Sender aborted: ${err.message}` : 'Sender aborted transfer');
        }
        this.updateStatus('FAILED', err?.message);
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      transferTimings.report(this.transferId);
      this.dispose();
    }
  }

  private assertChannelOpen() {
    if (this.channel.readyState !== 'open') {
      throw new Error('Connection to the shop was lost.');
    }
  }

  private waitForBufferDrain(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.channel.bufferedAmountLowThreshold = LIMITS.BUFFERED_AMOUNT_LOW_WATERMARK;

      const finish = (err?: Error) => {
        if (this.bufferDrainListener) {
          this.channel.removeEventListener('bufferedamountlow', this.bufferDrainListener);
          this.bufferDrainListener = null;
        }
        clearTimeout(timer);
        this.timers.delete(timer);
        if (err) reject(err);
        else resolve();
      };

      const timer = this.addTimer(() => {
        finish(new Error('Connection stalled while sending. Please try again.'));
      }, this.opts.bufferDrainTimeoutMs);

      this.bufferDrainListener = () => finish();
      this.channel.addEventListener('bufferedamountlow', this.bufferDrainListener);
    });
  }

  private waitForAck(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.earlyAck !== null) {
        const early = this.earlyAck;
        this.earlyAck = null;
        if (early === 'ok') resolve();
        else reject(early);
        return;
      }
      this.ackWaiter = { resolve, reject };
      this.addTimer(() => {
        this.settleAck(new Error('Shop verification timed out.'));
      }, this.opts.ackTimeoutMs);
    });
  }

  private waitForAccept(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.earlyAccept !== null) {
        const early = this.earlyAccept;
        this.earlyAccept = null;
        if (early === 'ok') resolve();
        else reject(early);
        return;
      }
      this.acceptWaiter = { resolve, reject };
      this.addTimer(() => {
        this.settleAccept(new Error('Queue wait timed out.'));
      }, this.opts.acceptTimeoutMs);
    });
  }

  private sendCancel(reason: string) {
    try {
      if (this.channel.readyState !== 'open') return;
      const cancelMsg: DataChannelControlMessage = {
        type: 'TRANSFER_CANCEL',
        transferId: this.transferId,
        reason: reason.slice(0, 200),
      };
      this.channel.send(JSON.stringify(cancelMsg));
    } catch {}
  }

  public cancel(reason = 'Cancelled by sender') {
    if (this.isCancelled) return;
    this.isCancelled = true;
    this.sendCancel(reason);
    this.updateStatus('CANCELLED');
    // Unblock start() immediately instead of letting it sit on a timeout.
    const err = new Error(reason);
    this.settleAccept(err);
    this.settleAck(err);
  }

  private updateStatus(status: TransferProgress['status'], error?: string) {
    this.callbacks.onStatusChange?.(status);

    // Preserve the real byte count. Previously every status change published
    // transferredBytes: 0, which is why a fully-sent file showed
    // "Verifying SHA-256… 0 B of 396.4 KB" — the bytes had all arrived, the UI
    // had just been overwritten with zeros.
    const bytes = status === 'COMPLETED' ? this.file.size : this.transferredBytes;
    const percentage =
      status === 'COMPLETED'
        ? 100
        : this.file.size > 0
        ? Math.min(100, Math.round((bytes / this.file.size) * 100))
        : 0;

    this.callbacks.onProgress?.({
      transferId: this.transferId,
      fileName: this.safeName,
      fileSize: this.file.size,
      transferredBytes: bytes,
      percentage,
      speedBytesPerSec: 0,
      estimatedRemainingSec: 0,
      status,
      error,
    });
  }
}
