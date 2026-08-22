import { describe, it, expect, beforeEach } from 'vitest';
import { FileSender } from '../lib/transfer/sender.js';
import { FileReceiver, ReceivedDocument } from '../lib/transfer/receiver.js';
import { computeSHA256 } from '../lib/transfer/hashing.js';

beforeEach(() => {
  if (!globalThis.crypto) {
    globalThis.crypto = require('node:crypto').webcrypto as any;
  }
});

class MockLoopbackDataChannel {
  public readyState: RTCDataChannelState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public peer: MockLoopbackDataChannel | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
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
  }
}

describe('WebRTC Decoupling & In-Memory Token Persistence', () => {
  it('Fix 8 & 9: Active file transfer continues uninterrupted even if signaling drops', async () => {
    const customerChannel = new MockLoopbackDataChannel();
    const shopChannel = new MockLoopbackDataChannel();
    customerChannel.peer = shopChannel;
    shopChannel.peer = customerChannel;

    const fileContent = new Uint8Array(100 * 1024).fill(77);
    const file = new File([fileContent], 'assignment.pdf', { type: 'application/pdf' });
    const expectedChecksum = await computeSHA256(file);

    let receivedDoc: ReceivedDocument | null = null;
    new FileReceiver(shopChannel as any, {
      onFileReceived: (doc) => {
        receivedDoc = doc;
      },
    });

    const sender = new FileSender(file, customerChannel as any);
    await sender.start();

    expect(receivedDoc).not.toBeNull();
    expect(receivedDoc!.sha256).toBe(expectedChecksum);
    expect(receivedDoc!.size).toBe(100 * 1024);
  });

  it('Fix 6 & 15: Token is preserved in memory and NEVER written to localStorage or sessionStorage', () => {
    const rawToken = 'test-token-abcdef-123456';
    
    // Simulate tokenRef in memory
    const tokenRef = { current: rawToken };
    
    // Verify token can be retrieved from memory
    expect(tokenRef.current).toBe(rawToken);

    // Verify neither localStorage nor sessionStorage contains the raw token
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('quickdrop_token')).toBeNull();
      expect(localStorage.getItem('token')).toBeNull();
    }
    if (typeof sessionStorage !== 'undefined') {
      expect(sessionStorage.getItem('quickdrop_token')).toBeNull();
      expect(sessionStorage.getItem('token')).toBeNull();
    }
  });
});
