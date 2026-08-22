/**
 * Transfer performance instrumentation.
 *
 * Records wall-clock marks for each stage of a single file transfer so real
 * latency can be measured on a real device instead of guessed at. Both the
 * sender (customer) and the receiver (shop) record into their own store; the
 * mark names differ per side because each only observes its own end of the wire.
 *
 * Enabled in dev by default and off in production builds. `setTransferTimingsEnabled()`
 * lets tests and ad-hoc debugging sessions flip it explicitly.
 */

export type TimingSide = 'sender' | 'receiver';

export interface TransferTimingRecord {
  transferId: string;
  side: TimingSide;
  fileName: string;
  fileSize: number;
  /** performance.now() when the transfer was first seen. */
  t0: number;
  /** Mark name → ms offset from t0. */
  marks: Record<string, number>;
}

export interface TransferMetrics {
  transferId: string;
  side: TimingSide;
  fileName: string;
  fileSize: number;
  /** SHA-256 of the local file, before any bytes were sent (sender only). */
  hashMs?: number;
  /** FILE_OFFER → FILE_ACCEPT round trip. Large values mean shop-side queueing. */
  offerToAcceptMs?: number;
  /** FILE_ACCEPT → first chunk on the wire. */
  acceptToFirstByteMs?: number;
  /** First chunk → last chunk. The actual throughput window. */
  transferMs?: number;
  /** SHA-256 verification of the reassembled blob (receiver only). */
  checksumMs?: number;
  /** FILE_END → TRANSFER_ACK. This is what times out at 30s on the sender. */
  ackMs?: number;
  /** First mark → terminal mark. */
  totalMs?: number;
  /** Effective bytes/sec over the transfer window. */
  throughputBytesPerSec?: number;
}

const MAX_RECORDS = 200;

let ENABLED = (() => {
  try {
    return Boolean((import.meta as any).env?.DEV);
  } catch {
    return false;
  }
})();

/** Turn timing collection + logging on or off (tests turn it off). */
export function setTransferTimingsEnabled(enabled: boolean) {
  ENABLED = enabled;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const fmt = (ms: number | undefined) => (ms === undefined ? '—' : `${Math.round(ms)}ms`);

class TransferTimings {
  private records = new Map<string, TransferTimingRecord>();
  private order: string[] = [];

  public start(transferId: string, side: TimingSide, fileName: string, fileSize: number) {
    if (!ENABLED) return;
    if (this.records.has(transferId)) return;
    this.records.set(transferId, {
      transferId,
      side,
      fileName,
      fileSize,
      t0: now(),
      marks: {},
    });
    this.order.push(transferId);
    // Bound the store: a long shop shift must not accumulate records forever.
    while (this.order.length > MAX_RECORDS) {
      const evicted = this.order.shift();
      if (evicted) this.records.delete(evicted);
    }
  }

  public mark(transferId: string, name: string) {
    if (!ENABLED) return;
    const rec = this.records.get(transferId);
    if (!rec) return;
    // First write wins: a retried/duplicated message must not skew the first
    // observation of that stage.
    if (rec.marks[name] === undefined) {
      rec.marks[name] = now() - rec.t0;
    }
  }

  public get(transferId: string): TransferTimingRecord | undefined {
    return this.records.get(transferId);
  }

  public metrics(transferId: string): TransferMetrics | undefined {
    const rec = this.records.get(transferId);
    if (!rec) return undefined;
    const m = rec.marks;
    const span = (a: string, b: string) =>
      m[a] !== undefined && m[b] !== undefined ? m[b] - m[a] : undefined;

    const firstChunk = rec.side === 'sender' ? 'firstChunkSentAt' : 'firstChunkAt';
    const lastChunk = rec.side === 'sender' ? 'lastChunkSentAt' : 'lastChunkAt';
    const offer = rec.side === 'sender' ? 'offerSentAt' : 'offerReceivedAt';
    const accept = rec.side === 'sender' ? 'acceptReceivedAt' : 'acceptSentAt';
    const fileEnd = rec.side === 'sender' ? 'fileEndSentAt' : 'fileEndReceivedAt';
    const ack = rec.side === 'sender' ? 'ackReceivedAt' : 'ackSentAt';

    const terminal = m.completedAt ?? m.failedAt;
    const transferMs = span(firstChunk, lastChunk);

    return {
      transferId,
      side: rec.side,
      fileName: rec.fileName,
      fileSize: rec.fileSize,
      hashMs: span('hashStartAt', 'hashEndAt'),
      offerToAcceptMs: span(offer, accept),
      acceptToFirstByteMs: span(accept, firstChunk),
      transferMs,
      checksumMs: span('checksumStartAt', 'checksumEndAt'),
      ackMs: span(fileEnd, ack),
      totalMs: terminal,
      throughputBytesPerSec:
        transferMs !== undefined && transferMs > 0 ? rec.fileSize / (transferMs / 1000) : undefined,
    };
  }

  /** One-line dev summary of where a transfer actually spent its time. */
  public report(transferId: string) {
    if (!ENABLED) return;
    const t = this.metrics(transferId);
    if (!t) return;
    const kbps =
      t.throughputBytesPerSec !== undefined
        ? `${(t.throughputBytesPerSec / 1024).toFixed(0)} KB/s`
        : '—';
    console.log(
      `[PERF][${t.side}] ${t.fileName} (${(t.fileSize / 1024).toFixed(1)} KB) ` +
        `hash=${fmt(t.hashMs)} offer→accept=${fmt(t.offerToAcceptMs)} ` +
        `accept→first=${fmt(t.acceptToFirstByteMs)} transfer=${fmt(t.transferMs)} (${kbps}) ` +
        `checksum=${fmt(t.checksumMs)} ack=${fmt(t.ackMs)} total=${fmt(t.totalMs)}`,
    );
  }

  public all(): TransferTimingRecord[] {
    return this.order.map((id) => this.records.get(id)).filter((r): r is TransferTimingRecord => !!r);
  }

  public clear() {
    this.records.clear();
    this.order = [];
  }
}

export const transferTimings = new TransferTimings();
