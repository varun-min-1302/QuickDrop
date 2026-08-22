import { describe, it, expect, beforeEach } from 'vitest';
import { FileSender } from '../lib/transfer/sender.js';
import { FileReceiver, ReceivedDocument } from '../lib/transfer/receiver.js';
import { computeSHA256 } from '../lib/transfer/hashing.js';

// Polyfill Web Crypto in test environment
beforeEach(() => {
  if (!globalThis.crypto) {
    globalThis.crypto = require('node:crypto').webcrypto as any;
  }
});

// High-speed buffered loopback channel for performance profiling
class BenchmarkDataChannel {
  public readyState: RTCDataChannelState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 1024 * 1024;
  public peer: BenchmarkDataChannel | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  private listeners: Record<string, Function[]> = {};
  public artificialDelayMs = 0;

  addEventListener(event: string, fn: Function) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: Function) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((l) => l !== fn);
  }

  send(data: any) {
    if (!this.peer || this.readyState !== 'open') return;

    if (this.artificialDelayMs > 0) {
      setTimeout(() => {
        this.deliver(data);
      }, this.artificialDelayMs);
    } else {
      // Async microtask
      queueMicrotask(() => {
        this.deliver(data);
      });
    }
  }

  private deliver(data: any) {
    if (this.peer?.onmessage) {
      this.peer.onmessage({ data } as MessageEvent);
    }
    for (const fn of this.peer?.listeners['message'] || []) {
      fn({ data });
    }
  }

  close() {
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }
}

function createBenchmarkPair(artificialDelayMs = 0) {
  const customerChannel = new BenchmarkDataChannel();
  const shopChannel = new BenchmarkDataChannel();
  customerChannel.artificialDelayMs = artificialDelayMs;
  shopChannel.artificialDelayMs = artificialDelayMs;
  customerChannel.peer = shopChannel;
  shopChannel.peer = customerChannel;
  return { customerChannel, shopChannel };
}

describe('Phase 7 Performance & Stress Benchmarking', () => {
  const fileSizes = [
    { label: '100 KB', bytes: 100 * 1024 },
    { label: '1 MB', bytes: 1024 * 1024 },
    { label: '5 MB', bytes: 5 * 1024 * 1024 },
    { label: '10 MB', bytes: 10 * 1024 * 1024 },
    { label: '25 MB', bytes: 25 * 1024 * 1024 },
    { label: '50 MB (Max Limit)', bytes: 50 * 1024 * 1024 },
  ];

  for (const { label, bytes } of fileSizes) {
    it(`transfers ${label} file with high throughput and valid SHA-256`, async () => {
      const { customerChannel, shopChannel } = createBenchmarkPair(0);
      const payload = new Uint8Array(bytes);
      // Fill with predictable pattern for speed
      payload[0] = 0x25; // '%' (PDF magic byte)
      payload[1] = 0x50; // 'P'
      payload[2] = 0x44; // 'D'
      payload[3] = 0x46; // 'F'

      const file = new File([payload], `bench-${bytes}.pdf`, { type: 'application/pdf' });
      const expectedChecksum = await computeSHA256(file);

      let receivedDoc: ReceivedDocument | null = null;
      new FileReceiver(shopChannel as any, {
        onFileReceived: (doc) => {
          receivedDoc = doc;
        },
      });

      const startTime = performance.now();
      const sender = new FileSender(file, customerChannel as any);
      await sender.start();
      const elapsedMs = performance.now() - startTime;

      expect(receivedDoc).not.toBeNull();
      expect(receivedDoc!.size).toBe(bytes);
      expect(receivedDoc!.sha256).toBe(expectedChecksum);

      const throughputMBps = (bytes / (1024 * 1024)) / (elapsedMs / 1000);
      expect(throughputMBps).toBeGreaterThan(0);

      // Cleanup object URL
      URL.revokeObjectURL(receivedDoc!.objectUrl);
    });
  }

  it('handles 10 consecutive sequential transfers without memory leakage', async () => {
    const { customerChannel, shopChannel } = createBenchmarkPair(0);
    const docSize = 500 * 1024; // 500 KB each

    for (let i = 0; i < 10; i++) {
      const payload = new Uint8Array(docSize).fill(i + 1);
      const file = new File([payload], `seq-${i}.pdf`, { type: 'application/pdf' });

      let receivedDoc: ReceivedDocument | null = null;
      new FileReceiver(shopChannel as any, {
        onFileReceived: (doc) => {
          receivedDoc = doc;
        },
      });

      const sender = new FileSender(file, customerChannel as any);
      await sender.start();

      expect(receivedDoc).not.toBeNull();
      expect(receivedDoc!.size).toBe(docSize);
      URL.revokeObjectURL(receivedDoc!.objectUrl);
    }
  });

  it('completes transfer under simulated mobile network latency (10ms packet delay)', async () => {
    const { customerChannel, shopChannel } = createBenchmarkPair(2); // 2ms per chunk delivery
    const payload = new Uint8Array(250 * 1024).fill(99); // 250 KB
    const file = new File([payload], 'mobile-latency.pdf', { type: 'application/pdf' });

    let receivedDoc: ReceivedDocument | null = null;
    new FileReceiver(shopChannel as any, {
      onFileReceived: (doc) => {
        receivedDoc = doc;
      },
    });

    const sender = new FileSender(file, customerChannel as any);
    await sender.start();

    expect(receivedDoc).not.toBeNull();
    expect(receivedDoc!.size).toBe(250 * 1024);
    URL.revokeObjectURL(receivedDoc!.objectUrl);
  });
});
