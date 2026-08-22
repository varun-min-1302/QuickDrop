import { describe, it, expect, beforeEach } from 'vitest';
import { FileSender } from '../lib/transfer/sender.js';
import { FileReceiver, ReceivedDocument } from '../lib/transfer/receiver.js';
import { isAllowedFile, sanitizeFilename } from '../lib/transfer/sanitizer.js';
import { computeSHA256 } from '../lib/transfer/hashing.js';

// Polyfill Web Crypto in test environment
beforeEach(() => {
  if (!globalThis.crypto) {
    globalThis.crypto = require('node:crypto').webcrypto as any;
  }
});

// Mock in-memory Loopback RTCDataChannel
class LoopbackDataChannel {
  public readyState: RTCDataChannelState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public peerChannel: LoopbackDataChannel | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  private eventListeners: Record<string, Function[]> = {};

  addEventListener(type: string, listener: Function) {
    if (!this.eventListeners[type]) this.eventListeners[type] = [];
    this.eventListeners[type].push(listener);
  }

  removeEventListener(type: string, listener: Function) {
    if (!this.eventListeners[type]) return;
    this.eventListeners[type] = this.eventListeners[type].filter((l) => l !== listener);
  }

  send(data: any) {
    if (!this.peerChannel) return;
    // Deliver async to simulate network tick
    setTimeout(() => {
      if (this.peerChannel?.onmessage) {
        this.peerChannel.onmessage({ data } as MessageEvent);
      }
      for (const listener of this.peerChannel?.eventListeners['message'] || []) {
        listener({ data });
      }
    }, 0);
  }

  close() {
    this.readyState = 'closed';
  }
}

function createLoopbackPair() {
  const senderChannel = new LoopbackDataChannel();
  const receiverChannel = new LoopbackDataChannel();
  senderChannel.peerChannel = receiverChannel;
  receiverChannel.peerChannel = senderChannel;
  return { senderChannel, receiverChannel };
}

describe('Phase 4 Document Transfer Engine & Binary Streaming', () => {
  describe('File Validation & Constraints', () => {
    it('accepts allowed document types and sizes up to 50 MB', () => {
      expect(isAllowedFile('resume.pdf', 1024).valid).toBe(true);
      expect(isAllowedFile('notes.docx', 1024 * 100).valid).toBe(true);
      expect(isAllowedFile('photo.png', 1024 * 1024 * 5).valid).toBe(true);
      expect(isAllowedFile('sheet.xlsx', 1024 * 1024 * 49).valid).toBe(true);
    });

    it('rejects empty files (0 bytes)', () => {
      const result = isAllowedFile('empty.pdf', 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('rejects oversized files exceeding 50 MB', () => {
      const result = isAllowedFile('huge.pdf', 51 * 1024 * 1024);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('50 MB');
    });

    it('rejects executable and disallowed file extensions', () => {
      expect(isAllowedFile('malware.exe', 1024).valid).toBe(false);
      expect(isAllowedFile('script.sh', 1024).valid).toBe(false);
      expect(isAllowedFile('payload.bat', 1024).valid).toBe(false);
    });

    it('sanitizes unsafe filenames and path traversal attempts', () => {
      expect(sanitizeFilename('../../../secret.pdf')).toBe('secret.pdf');
      expect(sanitizeFilename('report:final<version>.pdf')).toBe('report_final_version_.pdf');
    });
  });

  describe('End-to-End P2P Streaming Matrix over RTCDataChannel', () => {
    it('successfully transfers a 1 KB file with SHA-256 verification', async () => {
      const { senderChannel, receiverChannel } = createLoopbackPair();
      const payload = new Uint8Array(1024).fill(65); // 1 KB of 'A's
      const file = new File([payload], 'test-1kb.txt', { type: 'text/plain' });

      let receivedDoc: ReceivedDocument | null = null;
      new FileReceiver(receiverChannel as any, {
        onFileReceived: (doc) => {
          receivedDoc = doc;
        },
      });

      const sender = new FileSender(file, senderChannel as any);
      await sender.start();

      expect(receivedDoc).not.toBeNull();
      expect(receivedDoc!.size).toBe(1024);
      expect(receivedDoc!.name).toBe('test-1kb.txt');

      const expectedSha256 = await computeSHA256(file);
      expect(receivedDoc!.sha256).toBe(expectedSha256);
    });

    it('successfully transfers a 100 KB file (multi-chunk streaming)', async () => {
      const { senderChannel, receiverChannel } = createLoopbackPair();
      const payload = new Uint8Array(100 * 1024).fill(66);
      const file = new File([payload], 'document-100kb.pdf', { type: 'application/pdf' });

      let receivedDoc: ReceivedDocument | null = null;
      new FileReceiver(receiverChannel as any, {
        onFileReceived: (doc) => {
          receivedDoc = doc;
        },
      });

      const sender = new FileSender(file, senderChannel as any);
      await sender.start();

      expect(receivedDoc).not.toBeNull();
      expect(receivedDoc!.size).toBe(100 * 1024);
      expect(receivedDoc!.sha256).toBe(await computeSHA256(file));
    });

    it('successfully transfers a 1 MB file with real progress updates', async () => {
      const { senderChannel, receiverChannel } = createLoopbackPair();
      const payload = new Uint8Array(1024 * 1024).fill(67);
      const file = new File([payload], 'presentation-1mb.pptx', { type: 'application/vnd.ms-powerpoint' });

      let receivedDoc: ReceivedDocument | null = null;
      const progressUpdates: number[] = [];

      new FileReceiver(receiverChannel as any, {
        onFileReceived: (doc) => {
          receivedDoc = doc;
        },
      });

      const sender = new FileSender(file, senderChannel as any, {
        onProgress: (p) => {
          progressUpdates.push(p.percentage);
        },
      });

      await sender.start();

      expect(receivedDoc).not.toBeNull();
      expect(receivedDoc!.size).toBe(1024 * 1024);
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
    });
  });

  describe('Integrity & Error Recovery', () => {
    it('detects checksum mismatch and fails transfer with error ACK', async () => {
      const { senderChannel, receiverChannel } = createLoopbackPair();
      const payload = new Uint8Array(5000).fill(70);
      const file = new File([payload], 'corrupt-test.pdf', { type: 'application/pdf' });

      let receiverError: string | null = null;
      new FileReceiver(receiverChannel as any, {
        onError: (_id, err) => {
          receiverError = err;
        },
      });

      // Intercept sender channel to corrupt the SHA256 in FILE_START
      const originalSend = senderChannel.send.bind(senderChannel);
      senderChannel.send = (data: any) => {
        if (typeof data === 'string') {
          const parsed = JSON.parse(data);
          if (parsed.type === 'FILE_OFFER') {
            parsed.sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
            data = JSON.stringify(parsed);
          }
        }
        originalSend(data);
      };

      let senderError: any = null;
      const sender = new FileSender(file, senderChannel as any, {
        onError: (err) => {
          senderError = err;
        },
      });
      await sender.start();

      expect(senderError).not.toBeNull();
      expect(receiverError).toContain('Checksum mismatch');
    });

    it('handles transfer cancellation by sender', async () => {
      const { senderChannel } = createLoopbackPair();
      const payload = new Uint8Array(200 * 1024).fill(71);
      const file = new File([payload], 'cancel-test.pdf', { type: 'application/pdf' });

      const sender = new FileSender(file, senderChannel as any);
      sender.cancel('User aborted');

      expect(sender.isCancelled).toBe(true);
    });
  });
});
