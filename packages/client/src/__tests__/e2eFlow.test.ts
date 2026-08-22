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

// Full duplex loopback RTCDataChannel simulating browser-to-browser WebRTC transport
class WebRTCLoopbackDataChannel {
  public readyState: RTCDataChannelState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public peer: WebRTCLoopbackDataChannel | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  private listeners: Record<string, Function[]> = {};

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
    setTimeout(() => {
      if (this.peer?.onmessage) {
        this.peer.onmessage({ data } as MessageEvent);
      }
      for (const fn of this.peer?.listeners['message'] || []) {
        fn({ data });
      }
    }, 0);
  }

  close() {
    this.readyState = 'closed';
    if (this.onclose) this.onclose();
  }
}

describe('Phase 5 End-to-End System Flow Integration', () => {
  it('executes full transfer workflow: Customer Selects PDF -> WebRTC Stream -> SHA-256 Verify -> Shop Receives -> Print Ready', async () => {
    // 1. Setup peer WebRTC DataChannel connection
    const customerChannel = new WebRTCLoopbackDataChannel();
    const shopChannel = new WebRTCLoopbackDataChannel();
    customerChannel.peer = shopChannel;
    shopChannel.peer = customerChannel;

    // 2. Prepare mock PDF document
    const pdfContent = new Uint8Array(250 * 1024); // 250 KB PDF
    for (let i = 0; i < pdfContent.length; i++) {
      pdfContent[i] = (i % 256);
    }
    const customerFile = new File([pdfContent], 'Tax_Document_2026.pdf', {
      type: 'application/pdf',
      lastModified: Date.now(),
    });

    const expectedChecksum = await computeSHA256(customerFile);

    // 3. Shop attaches FileReceiver to open DataChannel
    let receivedDoc: ReceivedDocument | null = null;
    let shopCompleted = false;

    new FileReceiver(shopChannel as any, {
      onFileReceived: (doc) => {
        receivedDoc = doc;
        shopCompleted = true;
      },
    });

    // 4. Customer initiates streaming via FileSender
    let customerCompleted = false;
    const progressHistory: number[] = [];

    const sender = new FileSender(customerFile, customerChannel as any, {
      onProgress: (p) => {
        progressHistory.push(p.percentage);
      },
      onComplete: () => {
        customerCompleted = true;
      },
    });

    await sender.start();

    // 5. Verify End-to-End Delivery & Zero Tampering
    expect(customerCompleted).toBe(true);
    expect(shopCompleted).toBe(true);
    expect(receivedDoc).not.toBeNull();
    expect(receivedDoc!.name).toBe('Tax_Document_2026.pdf');
    expect(receivedDoc!.size).toBe(250 * 1024);
    expect(receivedDoc!.mime).toBe('application/pdf');
    expect(receivedDoc!.sha256).toBe(expectedChecksum);
    expect(receivedDoc!.objectUrl).toBeDefined();

    // 6. Verify progress milestones
    expect(progressHistory.length).toBeGreaterThan(0);
    expect(progressHistory[progressHistory.length - 1]).toBe(100);

    // 7. Verify memory cleanup
    URL.revokeObjectURL(receivedDoc!.objectUrl);
    customerChannel.close();
    shopChannel.close();
    expect(customerChannel.readyState).toBe('closed');
    expect(shopChannel.readyState).toBe('closed');
  });

  it('transfers multiple documents in sequential batch queue without data collision', async () => {
    const customerChannel = new WebRTCLoopbackDataChannel();
    const shopChannel = new WebRTCLoopbackDataChannel();
    customerChannel.peer = shopChannel;
    shopChannel.peer = customerChannel;

    const files = [
      new File([new Uint8Array(50 * 1024).fill(1)], 'doc1.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array(75 * 1024).fill(2)], 'doc2.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      new File([new Uint8Array(30 * 1024).fill(3)], 'doc3.png', { type: 'image/png' }),
    ];

    const receivedDocs: ReceivedDocument[] = [];
    new FileReceiver(shopChannel as any, {
      onFileReceived: (doc) => {
        receivedDocs.push(doc);
      },
    });

    // Send sequentially
    for (const file of files) {
      const sender = new FileSender(file, customerChannel as any);
      await sender.start();
    }

    expect(receivedDocs.length).toBe(3);
    expect(receivedDocs[0].name).toBe('doc1.pdf');
    expect(receivedDocs[1].name).toBe('doc2.docx');
    expect(receivedDocs[2].name).toBe('doc3.png');

    for (let i = 0; i < files.length; i++) {
      expect(receivedDocs[i].size).toBe(files[i].size);
      expect(receivedDocs[i].sha256).toBe(await computeSHA256(files[i]));
    }
  });
});
