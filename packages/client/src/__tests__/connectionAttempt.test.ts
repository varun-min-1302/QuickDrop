/**
 * ConnectionAttempt unit tests
 *
 * Tests every bounded timeout, stale-callback guard, and abort path
 * without touching React or real WebSockets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionAttempt, ConnectionAttemptOptions, ConnectionStage } from '../lib/webrtc/ConnectionAttempt.js';

// ── Fake timers ────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── MockSignalingClient ────────────────────────────────────────────────────────

class MockSignalingClient {
  public listeners: Record<string, Array<(...args: any[]) => void>> = {};
  public joined = false;
  public closed = false;
  public connectResolve: (() => void) | null = null;
  public connectReject: ((e: Error) => void) | null = null;

  connect() {
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
  }

  /** Trigger connection success */
  simulateOpen() { this.connectResolve?.(); }
  /** Trigger connection failure */
  simulateError(msg = 'ECONNREFUSED') { this.connectReject?.(new Error(msg)); }

  close() { this.closed = true; }
  join(_params: any) { this.joined = true; }
  sendOffer() {}
  sendAnswer() {}
  sendIceCandidate() {}
  updateCustomer() {}
  batchCompleted() {}

  on(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  off(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(h => h !== handler);
  }

  emit(event: string, ...args: any[]) {
    for (const h of (this.listeners[event] ?? [])) h(...args);
  }
}

// ── MockRTCDataChannel ─────────────────────────────────────────────────────────

class MockRTCDataChannel {
  public readyState: RTCDataChannelState = 'connecting';
  public binaryType = 'arraybuffer';
  public bufferedAmount = 0;
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((e: any) => void) | null = null;
  public onmessage: ((e: any) => void) | null = null;
  send(_data: any) {}
  close() { this.readyState = 'closed'; }
}

// ── MockRTCPeerConnection ──────────────────────────────────────────────────────

class MockRTCPeerConnection {
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public onicecandidate: ((e: any) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public ondatachannel: ((e: any) => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;
  constructor(public config: any) {}
  createDataChannel() { return new MockRTCDataChannel(); }
  async createOffer() { return { type: 'offer', sdp: 'mock' }; }
  async createAnswer() { return { type: 'answer', sdp: 'mock' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

// ── MockWebRTCPeer ─────────────────────────────────────────────────────────────

class MockWebRTCPeer {
  public peerConnection: MockRTCPeerConnection;
  public dataChannel: MockRTCDataChannel | null = null;
  public opts: any;

  constructor(opts: any) {
    this.opts = opts;
    this.peerConnection = new MockRTCPeerConnection({});
  }

  getState() { return 'CONNECTING' as const; }
  close() {}

  /** Test helper: simulate the DataChannel opening */
  triggerDataChannelOpen(channel: MockRTCDataChannel = new MockRTCDataChannel()) {
    channel.readyState = 'open';
    this.dataChannel = channel;
    if (channel.onopen) channel.onopen();
    this.opts.onDataChannelReady(channel);
  }

  /** Test helper: simulate connection state change */
  triggerConnectionState(state: RTCPeerConnectionState) {
    this.peerConnection.connectionState = state;
    this.opts.onConnectionStateChange?.(state);
  }

  /** Test helper: simulate ICE state change */
  triggerIceState(state: RTCIceConnectionState) {
    this.peerConnection.iceConnectionState = state;
    this.peerConnection.oniceconnectionstatechange?.();
  }
}

// ── Builder ────────────────────────────────────────────────────────────────────

type BuildResult = {
  attempt: ConnectionAttempt;
  sig: MockSignalingClient;
  getPeer: () => MockWebRTCPeer | null;
};

function buildAttempt(overrides: {
  attemptId?: number;
  isCurrent?: () => boolean;
  joinToken?: string;
  onStageChange?: (s: ConnectionStage) => void;
  onSessionData?: (code: string, batchId: string) => void;
  onConnected?: (ch: RTCDataChannel, code: string, batch: string) => void;
  onFailed?: (stage: ConnectionStage, detail: string) => void;
  onSessionEnded?: (r: 'SESSION_EXPIRED' | 'SESSION_CLOSED') => void;
} = {}): BuildResult {
  const sig = new MockSignalingClient();
  let createdPeer: MockWebRTCPeer | null = null;

  const opts: ConnectionAttemptOptions = {
    attemptId: overrides.attemptId ?? 1,
    isCurrentAttempt: overrides.isCurrent ?? (() => true),
    joinToken: overrides.joinToken ?? 'test-token-abc',
    callbacks: {
      onStageChange: overrides.onStageChange ?? vi.fn(),
      onSessionData: overrides.onSessionData ?? vi.fn(),
      onConnected: overrides.onConnected ?? vi.fn(),
      onFailed: overrides.onFailed ?? vi.fn(),
      onSessionEnded: overrides.onSessionEnded ?? vi.fn(),
    },
    signalingClientFactory: () => sig as any,
    webRTCPeerFactory: (peerOpts) => {
      const peer = new MockWebRTCPeer(peerOpts);
      createdPeer = peer;
      return peer as any;
    },
  };

  return {
    attempt: new ConnectionAttempt(opts),
    sig,
    getPeer: () => createdPeer,
  };
}

/** Advance timers AND drain microtasks */
async function tick(ms = 0) {
  vi.advanceTimersByTime(ms);
  // Drain the microtask queue several times to handle chained promises
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectionAttempt — WebSocket stage', () => {
  it('fails with INTERRUPTED when WS connection times out (10s)', async () => {
    const onFailed = vi.fn();
    const { attempt } = buildAttempt({ onFailed });
    // sig.connect() is a hanging promise (never resolved/rejected)

    attempt.start();
    await tick(10_001);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0]).toBe('INTERRUPTED');
    expect(onFailed.mock.calls[0][1]).toMatch(/timed out/i);
  });

  it('fails with INTERRUPTED when WS connection rejects immediately', async () => {
    const onFailed = vi.fn();
    const { attempt, sig } = buildAttempt({ onFailed });

    const p = attempt.start();
    sig.simulateError('ECONNREFUSED');
    await tick(0);
    await p;

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0]).toBe('INTERRUPTED');
  });
});

describe('ConnectionAttempt — JOIN stage', () => {
  it('fails with INTERRUPTED when server never responds to JOIN (10s timeout)', async () => {
    const onFailed = vi.fn();
    const { attempt, sig } = buildAttempt({ onFailed });

    attempt.start();
    // Open WS
    sig.simulateOpen();
    await tick(0);

    // JOIN was sent; now advance past the 10s JOIN timeout
    await tick(10_001);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0]).toBe('INTERRUPTED');
    expect(onFailed.mock.calls[0][1]).toMatch(/did not respond/i);
  }, 15_000);

  it('fails with SESSION_EXPIRED when server rejects with SESSION_EXPIRED', async () => {
    const onFailed = vi.fn();
    const { attempt, sig } = buildAttempt({ onFailed });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    sig.emit('join_rejected', { code: 'SESSION_EXPIRED', reason: 'Expired' });
    await tick(0);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0]).toBe('SESSION_EXPIRED');
  }, 15_000);

  it('fails with SESSION_NOT_FOUND when server rejects with SESSION_NOT_FOUND', async () => {
    const onFailed = vi.fn();
    const { attempt, sig } = buildAttempt({ onFailed });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    sig.emit('join_rejected', { code: 'SESSION_NOT_FOUND', reason: 'Not found' });
    await tick(0);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0]).toBe('SESSION_NOT_FOUND');
  }, 15_000);

  it('fires onSessionData immediately after JOIN_ACCEPTED', async () => {
    const onSessionData = vi.fn();
    const onFailed = vi.fn();
    const { attempt, sig } = buildAttempt({ onSessionData, onFailed });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    sig.emit('join_accepted', {
      customerCode: 'ABC12',
      batchId: 'batch_test',
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    await tick(0);

    expect(onSessionData).toHaveBeenCalledWith('ABC12', 'batch_test');

    // Clean up
    attempt.abort('test-cleanup');
    await tick(30_000);
  }, 35_000);
});

describe('ConnectionAttempt — WAITING_FOR_SHOP stage', () => {
  it('fails with INTERRUPTED (mentioning shop) when no shop arrives within 15s', async () => {
    const onFailed = vi.fn();
    const { attempt, sig } = buildAttempt({ onFailed });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    // JOIN_ACCEPTED — customer gets session data
    sig.emit('join_accepted', {
      customerCode: 'ABC12',
      batchId: 'batch_test',
      iceServers: [],
    });
    await tick(0);

    // Shop never shows up; advance past the 15s shop-wait timeout
    await tick(15_001);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0]).toBe('INTERRUPTED');
    expect(onFailed.mock.calls[0][1]).toMatch(/shop/i);
  }, 30_000);

  it('advances past WAITING_FOR_SHOP when shop peer arrives', async () => {
    const stages: ConnectionStage[] = [];
    const onStageChange = (s: ConnectionStage) => stages.push(s);
    const { attempt, sig } = buildAttempt({ onStageChange });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    sig.emit('join_accepted', {
      customerCode: 'ABC12', batchId: 'batch_test', iceServers: [],
    });
    await tick(0);

    // At this point we should be in WAITING_FOR_SHOP
    expect(stages).toContain('WAITING_FOR_SHOP');

    // Shop arrives
    sig.emit('peer_joined', { role: 'shop', peerId: 'shop-123' });
    await tick(0);

    expect(stages).toContain('NEGOTIATING_WEBRTC');

    // Abort before DC timeout fires
    attempt.abort('test');
    await tick(30_000);
  }, 35_000);
});

describe('ConnectionAttempt — Abort / stale callback protection', () => {
  it('does not invoke onFailed after abort()', async () => {
    const onFailed = vi.fn();
    const { attempt } = buildAttempt({ onFailed });
    // sig.connect() hangs — never resolved

    attempt.start(); // kick off but don't advance timers yet
    await tick(0);

    attempt.abort('test');

    // Advance well past all timeouts
    await tick(30_001);

    expect(onFailed).not.toHaveBeenCalled();
  }, 35_000);

  it('does not invoke callbacks when isCurrentAttempt() returns false', async () => {
    const onFailed = vi.fn();
    const onSessionData = vi.fn();
    let isCurrent = true;
    const { attempt, sig } = buildAttempt({
      onFailed,
      onSessionData,
      isCurrent: () => isCurrent,
    });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    // Externally invalidate the attempt (simulates retry incrementing attemptIdRef)
    isCurrent = false;

    sig.emit('join_accepted', {
      customerCode: 'SHOULD_NOT_APPEAR', batchId: 'b', iceServers: [],
    });
    await tick(0);
    expect(onSessionData).not.toHaveBeenCalled();

    sig.emit('join_rejected', { code: 'SESSION_NOT_FOUND', reason: 'gone' });
    await tick(0);
    expect(onFailed).not.toHaveBeenCalled();

    attempt.abort('test');
    await tick(30_000);
  }, 35_000);

  it('abort() is idempotent — calling twice does not throw', () => {
    const { attempt } = buildAttempt();
    expect(() => {
      attempt.abort('first');
      attempt.abort('second');
    }).not.toThrow();
  });
});

describe('ConnectionAttempt — Total 30s hard cap', () => {
  it('fires onFailed after 30s even if no sub-stage timer fires', async () => {
    const onFailed = vi.fn();
    const { attempt } = buildAttempt({ onFailed });
    // WS hangs

    attempt.start();
    await tick(30_001);

    expect(onFailed).toHaveBeenCalled();
    expect(onFailed.mock.calls[0][0]).toBe('INTERRUPTED');
  }, 35_000);
});

describe('ConnectionAttempt — Successful flow', () => {
  it('calls onConnected when DataChannel opens', async () => {
    const onConnected = vi.fn();
    const onFailed = vi.fn();
    const { attempt, sig, getPeer } = buildAttempt({ onConnected, onFailed });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    sig.emit('join_accepted', {
      customerCode: 'XYZ99', batchId: 'batch_abc', iceServers: [],
    });
    await tick(0);

    sig.emit('peer_joined', { role: 'shop', peerId: 'shop-peer' });
    await tick(0);

    // By now, the WebRTCPeer factory must have been called
    const peer = getPeer();
    expect(peer).not.toBeNull();

    // Simulate DataChannel opening
    peer!.triggerDataChannelOpen();
    await tick(0);

    expect(onFailed).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledOnce();
    expect(onConnected.mock.calls[0][1]).toBe('XYZ99');
    expect(onConnected.mock.calls[0][2]).toBe('batch_abc');
  }, 35_000);
});

describe('ConnectionAttempt — RTCPeerConnection failure', () => {
  it('calls onFailed when RTCPeerConnection state becomes "failed"', async () => {
    const onFailed = vi.fn();
    const { attempt, sig, getPeer } = buildAttempt({ onFailed });

    attempt.start();
    sig.simulateOpen();
    await tick(0);

    sig.emit('join_accepted', { customerCode: 'A', batchId: 'b', iceServers: [] });
    await tick(0);

    sig.emit('peer_joined', { role: 'shop', peerId: 'shop-peer' });
    await tick(0);

    const peer = getPeer();
    expect(peer).not.toBeNull();

    peer!.triggerConnectionState('failed');
    await tick(0);

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0][0]).toBe('INTERRUPTED');
  }, 35_000);
});
