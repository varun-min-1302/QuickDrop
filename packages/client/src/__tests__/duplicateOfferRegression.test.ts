/**
 * Regression test for the customer-side WebRTC crash:
 *   "Failed to execute 'setLocalDescription' on 'RTCPeerConnection':
 *    Failed to set local answer sdp: Called in wrong state: stable"
 *
 * Root cause: the shop could emit more than one OFFER for the same customer
 * (a leaked/duplicated signaling listener on the shop, or a WebSocket blip that
 * caused an auto-rejoin and a fresh server-side OFFER). The customer's answer
 * handler had no reentrancy guard, so two invocations raced: the first drove the
 * peer connection back to `stable`, and the second's setLocalDescription(answer)
 * threw because an answer is only legal in `have-remote-offer`.
 *
 * The mock RTCPeerConnection below models the REAL signalingState machine, so if
 * the guard in peerConnection.ts is ever removed these tests fail with exactly the
 * production error rather than silently passing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebRTCPeer } from '../lib/webrtc/peerConnection.js';

// ── Stateful mock RTCPeerConnection ─────────────────────────────────────────────
// Only the state transitions relevant to the answerer path are modeled.
class StatefulMockPeerConnection {
  public signalingState: RTCSignalingState = 'stable';
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public iceGatheringState: RTCIceGatheringState = 'new';
  public localDescription: any = null;
  public remoteDescription: any = null;
  public onicecandidate: ((e: any) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public ondatachannel: ((e: any) => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;

  constructor(public config: any) {}

  async setRemoteDescription(desc: any) {
    if (desc.type === 'offer') {
      // Legal from `stable`; moves us to `have-remote-offer`.
      this.signalingState = 'have-remote-offer';
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable';
    }
    this.remoteDescription = desc;
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }

  async setLocalDescription(desc: any) {
    if (desc.type === 'answer') {
      // This is the exact invariant the production bug violated.
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error(
          `Failed to execute 'setLocalDescription' on 'RTCPeerConnection': ` +
            `Failed to set local answer sdp: Called in wrong state: ${this.signalingState}`
        );
      }
      this.signalingState = 'stable';
    } else if (desc.type === 'offer') {
      this.signalingState = 'have-local-offer';
    }
    this.localDescription = desc;
  }

  async addIceCandidate() {}
  createDataChannel() { return {} as RTCDataChannel; }
  close() {}
}

// ── Minimal signaling stub with an emit() escape hatch ───────────────────────────
class MockSignaling {
  public listeners: Record<string, Array<(...args: any[]) => void>> = {};
  public answers: Array<{ sdp: any; target?: string }> = [];

  on(event: string, handler: (...args: any[]) => void) {
    (this.listeners[event] ||= []).push(handler);
  }
  off(event: string, handler: (...args: any[]) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((h) => h !== handler);
  }
  emit(event: string, data: any) {
    for (const h of this.listeners[event] ?? []) h(data);
  }
  sendAnswer(sdp: any, target?: string) {
    this.answers.push({ sdp, target });
  }
  sendOffer() {}
  sendIceCandidate() {}
}

/** Drain the microtask queue so all chained awaits in the handler settle. */
async function flush() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

function makeOffer(sdp: string, fromPeerId = 'shop-peer-1') {
  return { sdp: { type: 'offer', sdp }, fromPeerId };
}

beforeEach(() => {
  (globalThis as any).RTCPeerConnection = StatefulMockPeerConnection;
  (globalThis as any).RTCSessionDescription = function (desc: any) { return desc; };
  (globalThis as any).RTCIceCandidate = function (cand: any) { return cand; };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebRTCPeer — duplicate OFFER handling (customer)', () => {
  it('answers a single offer exactly once (happy path)', async () => {
    const sig = new MockSignaling();
    const onError = vi.fn();
    const peer = new WebRTCPeer({
      role: 'customer',
      signalingClient: sig as any,
      iceServers: [],
      onDataChannelReady: () => {},
      onError,
    });

    sig.emit('offer', makeOffer('offer-a'));
    await flush();

    expect(sig.answers).toHaveLength(1);
    expect(sig.answers[0].sdp.type).toBe('answer');
    expect(sig.answers[0].target).toBe('shop-peer-1');
    expect(onError).not.toHaveBeenCalled();
    expect(peer.getState()).not.toBe('FAILED');
    expect(peer.peerConnection.signalingState).toBe('stable');
  });

  it('ignores a second concurrent offer — one answer, no "wrong state" crash', async () => {
    const sig = new MockSignaling();
    const onError = vi.fn();
    const peer = new WebRTCPeer({
      role: 'customer',
      signalingClient: sig as any,
      iceServers: [],
      onDataChannelReady: () => {},
      onError,
    });

    // Two offers fired back-to-back: the first suspends at its first await while
    // the second runs synchronously. Without the isNegotiating guard, the second
    // would race to setLocalDescription and throw "Called in wrong state: stable".
    sig.emit('offer', makeOffer('offer-a'));
    sig.emit('offer', makeOffer('offer-b'));
    await flush();

    expect(sig.answers).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(peer.getState()).not.toBe('FAILED');
    expect(peer.peerConnection.signalingState).toBe('stable');
  });

  it('ignores a late offer that arrives after negotiation has completed', async () => {
    const sig = new MockSignaling();
    const onError = vi.fn();
    const peer = new WebRTCPeer({
      role: 'customer',
      signalingClient: sig as any,
      iceServers: [],
      onDataChannelReady: () => {},
      onError,
    });

    // First offer fully negotiates (hasNegotiated becomes true).
    sig.emit('offer', makeOffer('offer-a'));
    await flush();
    expect(sig.answers).toHaveLength(1);

    // A later duplicate offer (e.g. from a reconnect) must be ignored.
    sig.emit('offer', makeOffer('offer-b'));
    await flush();

    expect(sig.answers).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    expect(peer.getState()).not.toBe('FAILED');
  });
});
