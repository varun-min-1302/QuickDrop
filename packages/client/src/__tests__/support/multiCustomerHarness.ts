/**
 * Shared harness for driving the REAL {@link ShopPeerManager} and REAL
 * {@link FileReceiver} with several customers at once.
 *
 * The single-customer variant of this lives inline in `transferQueueDeadlock.test.ts`.
 * Multi-customer work needs three things that one does not have, so the pieces are
 * factored out here rather than copied:
 *
 *   • a customer whose DataChannel can be opened LATER than its JOIN, so "A, B and C
 *     all connect at once" can actually be staged instead of serialised;
 *   • a `peerId` that can differ from the clientId, so a reconnect can be modelled as
 *     the same logical customer arriving on a new transport;
 *   • offer and finish as separate steps, because a queued file is offered long before
 *     it is allowed to send a single byte.
 *
 * Not a test file: no `.test.` in the name, so vitest's default include pattern
 * ignores it.
 */
import { vi } from 'vitest';
import {
  ShopPeerManager,
  ShopPeerManagerEvents,
} from '../../lib/webrtc/ShopPeerManager.js';
import { computeSHA256 } from '../../lib/transfer/hashing.js';
import { encodeChunkPacket } from '../../lib/transfer/protocol.js';

/** A checksum that no real payload will match — for offers meant to fail or to be cancelled. */
export const ZERO_SHA = '0'.repeat(64);

/** A DataChannel we can push inbound frames into and inspect outbound ones on. */
export class MockChannel {
  public readyState: RTCDataChannelState = 'open';
  public bufferedAmount = 0;
  public bufferedAmountLowThreshold = 0;
  public binaryType = 'arraybuffer';
  public onmessage: ((event: MessageEvent) => void) | null = null;
  private listeners: Record<string, Function[]> = {};
  /** Every control message the shop sent back to this customer, parsed. */
  public sent: any[] = [];

  addEventListener(type: string, fn: Function) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type: string, fn: Function) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }
  send(data: any) {
    if (typeof data === 'string') {
      try {
        this.sent.push(JSON.parse(data));
      } catch {
        this.sent.push(data);
      }
    } else {
      this.sent.push(data);
    }
  }
  /** Simulate an inbound frame from the customer. */
  deliver(data: any) {
    this.onmessage?.({ data } as MessageEvent);
    for (const fn of this.listeners['message'] ?? []) fn({ data });
  }
  close() {
    this.readyState = 'closed';
  }

  sentOfType(type: string) {
    return this.sent.filter((m) => m && m.type === type);
  }
  acceptedIds(): string[] {
    return this.sentOfType('FILE_ACCEPT').map((m) => m.transferId);
  }
  waitingIds(): string[] {
    return this.sentOfType('FILE_WAITING').map((m) => m.transferId);
  }
  cancelledIds(): string[] {
    return this.sentOfType('TRANSFER_CANCEL').map((m) => m.transferId);
  }
}

export interface MockPeer {
  opts: any;
  startOffer: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  peerConnection: any;
}

/** Let all pending microtasks + one macrotask settle (SHA-256 is async). */
export async function flush(times = 3) {
  for (let t = 0; t < times; t++) {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

export interface JoinOptions {
  customerCode?: string;
  displayName?: string | null;
  batchId?: string;
  /** Transport identity. Defaults to `peer-<clientId>`; pass a new one to model a reconnect. */
  peerId?: string;
  /**
   * When true the customer JOINs but its WebRTC connection and DataChannel are left
   * unopened, so several customers can be mid-handshake simultaneously. Call the
   * returned `connect()` when you want it to come up.
   */
  defer?: boolean;
}

export interface JoinedCustomer {
  clientId: string;
  peerId: string;
  peer: MockPeer;
  channel: MockChannel;
  /** Bring the WebRTC connection + DataChannel up (no-op if already done). */
  connect: () => void;
}

export function createShop(options?: ConstructorParameters<typeof ShopPeerManager>[3]) {
  const peers = new Map<string, MockPeer>();
  /** Every peer ever built, in creation order — reconnects append rather than replace. */
  const peerLog: MockPeer[] = [];
  const listeners: Record<string, Function[]> = {};

  const signaling: any = {
    on: (event: string, fn: Function) => {
      (listeners[event] ||= []).push(fn);
    },
    off: (event: string, fn: Function) => {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== fn);
    },
    emit: (event: string, data: any) => {
      for (const fn of listeners[event] ?? []) fn(data);
    },
    listenerCount: (event: string) => (listeners[event] ?? []).length,
  };

  // `-?` strips the optionality the event interface has: every handler is always
  // present here, so tests can reach into `.mock.calls` without a null check.
  const events: { [K in keyof ShopPeerManagerEvents]-?: ReturnType<typeof vi.fn> } = {
    onCustomerJoined: vi.fn(),
    onCustomerUpdated: vi.fn(),
    onCustomerLeft: vi.fn(),
    onConnectionStateChange: vi.fn(),
    onTransferProgress: vi.fn(),
    onFileReceived: vi.fn(),
    onError: vi.fn(),
  };

  const manager = new ShopPeerManager(signaling, [], events, {
    webRTCPeerFactory: (opts: any) => {
      const peer: MockPeer = {
        opts,
        startOffer: vi.fn(),
        close: vi.fn(),
        peerConnection: {},
      };
      peers.set(opts.targetPeerId, peer);
      peerLog.push(peer);
      return peer as any;
    },
    ...options,
  });

  /** Deliver PEER_JOINED for a customer, then (unless deferred) bring its channel up. */
  function joinCustomer(clientId: string, opts: JoinOptions = {}): JoinedCustomer {
    const peerId = opts.peerId ?? `peer-${clientId}`;
    signaling.emit('peer_joined', {
      peerId,
      role: 'customer',
      customer: {
        clientId,
        customerCode: opts.customerCode ?? clientId.toUpperCase(),
        displayName: opts.displayName ?? null,
        batchId: opts.batchId ?? `batch-${clientId}`,
      },
    });
    const peer = peers.get(peerId)!;
    const channel = new MockChannel();
    let connected = false;
    const connect = () => {
      if (connected) return;
      connected = true;
      peer.opts.onConnectionStateChange('connected');
      peer.opts.onDataChannelReady(channel);
    };
    if (!opts.defer) connect();
    return { clientId, peerId, peer, channel, connect };
  }

  /** The customer's socket dropped: server relays PEER_LEFT. */
  function leave(clientId: string, peerId?: string) {
    signaling.emit('peer_left', {
      peerId: peerId ?? `peer-${clientId}`,
      role: 'customer',
      clientId,
    });
  }

  /** The customer's WebRTC connection died without the socket noticing. */
  function failWebRTC(customer: JoinedCustomer, state: RTCPeerConnectionState = 'failed') {
    customer.peer.opts.onConnectionStateChange(state);
  }

  return { manager, signaling, events, peers, peerLog, joinCustomer, leave, failWebRTC };
}

// ─── Protocol drivers (customer → shop) ───────────────────────────────────────

export function offerFile(
  channel: MockChannel,
  transferId: string,
  opts: { name?: string; size: number; totalChunks: number; sha256: string; mime?: string },
) {
  channel.deliver(
    JSON.stringify({
      type: 'FILE_OFFER',
      transferId,
      name: opts.name ?? `${transferId.slice(0, 6)}.pdf`,
      size: opts.size,
      mime: opts.mime ?? 'application/pdf',
      totalChunks: opts.totalChunks,
      chunkSize: 65536,
      sha256: opts.sha256,
      protocolVersion: '1.0',
    }),
  );
}

export function sendChunk(
  channel: MockChannel,
  transferId: string,
  index: number,
  bytes: Uint8Array,
) {
  channel.deliver(encodeChunkPacket(transferId, index, bytes.buffer as ArrayBuffer));
}

export function sendFileEnd(channel: MockChannel, transferId: string) {
  channel.deliver(JSON.stringify({ type: 'FILE_END', transferId }));
}

export function sendCancel(channel: MockChannel, transferId: string, reason = 'user cancelled') {
  channel.deliver(JSON.stringify({ type: 'TRANSFER_CANCEL', transferId, reason }));
}

/**
 * Offer a file with a checksum that its payload really does match, and hand back the
 * bytes so it can be finished later. Split from {@link finishFile} because a QUEUED
 * file is offered long before it may send anything.
 */
export async function offerRealFile(
  channel: MockChannel,
  transferId: string,
  opts: { name?: string; sizeBytes?: number } = {},
): Promise<Uint8Array> {
  const bytes = new Uint8Array(opts.sizeBytes ?? 1024).fill(65);
  const sha = await computeSHA256(new Blob([bytes]));
  offerFile(channel, transferId, {
    name: opts.name,
    size: bytes.byteLength,
    totalChunks: 1,
    sha256: sha,
  });
  await flush(1);
  return bytes;
}

/** Send the payload + FILE_END for a file previously offered by {@link offerRealFile}. */
export async function finishFile(channel: MockChannel, transferId: string, bytes: Uint8Array) {
  sendChunk(channel, transferId, 0, bytes);
  await flush(1);
  sendFileEnd(channel, transferId);
  await flush(2);
}

/** Offer + payload + FILE_END, i.e. one clean successful transfer. */
export async function completeFile(
  channel: MockChannel,
  transferId: string,
  opts: { name?: string; sizeBytes?: number } = {},
) {
  const bytes = await offerRealFile(channel, transferId, opts);
  await finishFile(channel, transferId, bytes);
}
