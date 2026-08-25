/**
 * Regression suite for shop-side signaling cross-talk — the root cause of real-device
 * bugs 4 and 1.
 *
 * The shop runs one {@link WebRTCPeer} per customer, but they all share ONE
 * SignalingClient, and `SignalingClient.emit` fans every message out to every registered
 * listener with no routing whatsoever. `answer` and `ice_candidate` were registered
 * unfiltered, so when three phones scanned the same QR at once:
 *
 *   • customer B's ANSWER was also handed to A's peer. A was already `stable`, so
 *     setRemoteDescription threw "Called in wrong state: stable" → onError → the shop
 *     finalized A's leases and closed A's channel. A's phone saw its healthy transfer
 *     die and re-initialised — which is exactly what "B pressing Send restarts A's page"
 *     was.
 *   • the same ANSWER was handed to C's peer, which WAS in `have-local-offer` and so
 *     accepted it, then negotiated against the wrong DTLS fingerprint. C's DataChannel
 *     never opened; C timed out.
 *   • ICE candidates polluted every other customer's candidate pool.
 *
 * Which customer broke depended purely on message interleaving, which is why it looked
 * random on real devices and could never reproduce with one phone.
 *
 * The mock RTCPeerConnection below throws on a wrongly-timed answer exactly like a real
 * browser does, so these tests fail loudly if the routing guard is ever removed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebRTCPeer } from '../lib/webrtc/peerConnection.js';
import { SignalingClient } from '../lib/webrtc/signalingClient.js';

// ─── A peer connection that enforces real signaling-state rules ───────────────

class MockDataChannel {
  public readyState: RTCDataChannelState = 'connecting';
  public binaryType = 'blob';
  public bufferedAmount = 0;
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((err: any) => void) | null = null;
  public onmessage: ((event: any) => void) | null = null;
  send(_data: any) {}
  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class MockPeerConnection {
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public iceGatheringState: RTCIceGatheringState = 'new';
  public signalingState: RTCSignalingState = 'stable';
  public onicecandidate: ((event: any) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public ondatachannel: ((event: any) => void) | null = null;

  /** Every remote SDP this connection actually applied. */
  public appliedRemoteSdps: string[] = [];
  public appliedCandidates: string[] = [];

  constructor(public config: any) {}

  createDataChannel(_label: string, _options?: any) {
    return new MockDataChannel() as any;
  }
  async createOffer(_opts?: any) {
    return { type: 'offer', sdp: 'local-offer-sdp' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'local-answer-sdp' };
  }
  async setLocalDescription(desc: any) {
    this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(desc: any) {
    // Exactly the browser's rule, and the source of the original crash.
    if (desc.type === 'answer' && this.signalingState !== 'have-local-offer') {
      throw new Error(
        `Failed to set remote answer sdp: Called in wrong state: ${this.signalingState}`,
      );
    }
    this.appliedRemoteSdps.push(desc.sdp);
    this.signalingState = 'stable';
  }
  async addIceCandidate(candidate: any) {
    this.appliedCandidates.push(candidate.candidate);
  }
  close() {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
    this.onconnectionstatechange?.();
  }
}

interface ShopPeerFixture {
  peer: WebRTCPeer;
  pc: MockPeerConnection;
  onError: ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  (global as any).RTCPeerConnection = MockPeerConnection;
  (global as any).RTCSessionDescription = function (desc: any) {
    return desc;
  };
  (global as any).RTCIceCandidate = function (cand: any) {
    return cand;
  };
});

/** One SignalingClient, shared by every peer — as in the real shop. */
function sharedSignaling() {
  const signaling = new SignalingClient('ws://localhost:3000/ws');
  return {
    signaling,
    /** Push a server-shaped message through the REAL parse/emit path. */
    deliver(msg: any) {
      (signaling as any).handleMessage(msg);
    },
    listenerCount(event: string) {
      return ((signaling as any).listeners[event] ?? []).length;
    },
  };
}

function shopPeerFor(signaling: SignalingClient, targetPeerId: string): ShopPeerFixture {
  const onError = vi.fn();
  const peer = new WebRTCPeer({
    role: 'shop',
    signalingClient: signaling,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    targetPeerId,
    onDataChannelReady: () => {},
    onError,
  });
  return { peer, pc: peer.peerConnection as unknown as MockPeerConnection, onError };
}

function answerFrom(fromPeerId: string, sdp: string) {
  return { type: 'ANSWER', sdp: { type: 'answer', sdp }, fromPeerId };
}

function candidateFrom(fromPeerId: string, candidate: string) {
  return {
    type: 'ICE_CANDIDATE',
    candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 },
    fromPeerId,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('shop peers on one shared SignalingClient are routed by peerId', () => {
  it("B's ANSWER reaches only B — A and C are untouched and unbroken", async () => {
    const { signaling, deliver } = sharedSignaling();
    const a = shopPeerFor(signaling, 'peer-a');
    const b = shopPeerFor(signaling, 'peer-b');
    const c = shopPeerFor(signaling, 'peer-c');

    await Promise.all([a.peer.startOffer(), b.peer.startOffer(), c.peer.startOffer()]);
    expect([a, b, c].every((p) => p.pc.signalingState === 'have-local-offer')).toBe(true);

    deliver(answerFrom('peer-b', 'sdp-from-B'));
    await Promise.resolve();

    expect(b.pc.appliedRemoteSdps).toEqual(['sdp-from-B']);
    expect(a.pc.appliedRemoteSdps).toEqual([]);
    expect(c.pc.appliedRemoteSdps).toEqual([]);
    // A and C are still waiting for their own answers, not wedged or failed.
    expect(a.pc.signalingState).toBe('have-local-offer');
    expect(c.pc.signalingState).toBe('have-local-offer');
    expect(a.onError).not.toHaveBeenCalled();
    expect(c.onError).not.toHaveBeenCalled();
    expect(a.peer.getState()).not.toBe('FAILED');
    expect(c.peer.getState()).not.toBe('FAILED');
  });

  it('three answers arriving in any order each land on their own peer', async () => {
    const { signaling, deliver } = sharedSignaling();
    const a = shopPeerFor(signaling, 'peer-a');
    const b = shopPeerFor(signaling, 'peer-b');
    const c = shopPeerFor(signaling, 'peer-c');
    await Promise.all([a.peer.startOffer(), b.peer.startOffer(), c.peer.startOffer()]);

    for (const msg of [
      answerFrom('peer-c', 'sdp-C'),
      answerFrom('peer-a', 'sdp-A'),
      answerFrom('peer-b', 'sdp-B'),
    ]) {
      deliver(msg);
      await Promise.resolve();
    }

    expect(a.pc.appliedRemoteSdps).toEqual(['sdp-A']);
    expect(b.pc.appliedRemoteSdps).toEqual(['sdp-B']);
    expect(c.pc.appliedRemoteSdps).toEqual(['sdp-C']);
    for (const p of [a, b, c]) expect(p.onError).not.toHaveBeenCalled();
  });

  it('an ANSWER arriving when the peer is not awaiting one is ignored, not thrown', async () => {
    const { signaling, deliver } = sharedSignaling();
    const a = shopPeerFor(signaling, 'peer-a');
    await a.peer.startOffer();

    deliver(answerFrom('peer-a', 'sdp-A'));
    await Promise.resolve();
    expect(a.pc.signalingState).toBe('stable');

    // A stray duplicate for the SAME peer — the state guard must catch it even though
    // routing already passed.
    deliver(answerFrom('peer-a', 'sdp-A-again'));
    await Promise.resolve();

    expect(a.pc.appliedRemoteSdps).toEqual(['sdp-A']);
    expect(a.onError).not.toHaveBeenCalled();
    expect(a.peer.getState()).not.toBe('FAILED');
  });

  it("ICE candidates only enter their own peer's pool", async () => {
    const { signaling, deliver } = sharedSignaling();
    const a = shopPeerFor(signaling, 'peer-a');
    const b = shopPeerFor(signaling, 'peer-b');
    await Promise.all([a.peer.startOffer(), b.peer.startOffer()]);

    // Answers first so candidates apply immediately rather than queueing.
    deliver(answerFrom('peer-a', 'sdp-A'));
    deliver(answerFrom('peer-b', 'sdp-B'));
    await Promise.resolve();

    deliver(candidateFrom('peer-b', 'cand-B1'));
    deliver(candidateFrom('peer-a', 'cand-A1'));
    deliver(candidateFrom('peer-b', 'cand-B2'));
    await Promise.resolve();

    expect(a.pc.appliedCandidates).toEqual(['cand-A1']);
    expect(b.pc.appliedCandidates).toEqual(['cand-B1', 'cand-B2']);
  });

  it("a foreign peer's candidates are dropped rather than queued for later", async () => {
    const { signaling, deliver } = sharedSignaling();
    const a = shopPeerFor(signaling, 'peer-a');
    await a.peer.startOffer();

    // Before any remote description: a matching candidate is held, a foreign one dropped.
    deliver(candidateFrom('peer-zzz', 'cand-foreign'));
    deliver(candidateFrom('peer-a', 'cand-mine'));
    await Promise.resolve();

    deliver(answerFrom('peer-a', 'sdp-A'));
    await Promise.resolve();
    await Promise.resolve();

    expect(a.pc.appliedCandidates).toEqual(['cand-mine']);
  });
});

describe('a closed peer detaches from the shared client', () => {
  it('removes exactly its own listeners, leaving the others registered', () => {
    const { signaling, listenerCount } = sharedSignaling();
    const a = shopPeerFor(signaling, 'peer-a');
    const b = shopPeerFor(signaling, 'peer-b');

    expect(listenerCount('answer')).toBe(2);
    expect(listenerCount('ice_candidate')).toBe(2);
    expect(listenerCount('offer')).toBe(2);

    a.peer.close();

    expect(listenerCount('answer')).toBe(1);
    expect(listenerCount('ice_candidate')).toBe(1);
    expect(listenerCount('offer')).toBe(1);
    void b;
  });

  it('ignores traffic addressed to it after close, and close is idempotent', async () => {
    const { signaling, deliver, listenerCount } = sharedSignaling();
    const a = shopPeerFor(signaling, 'peer-a');
    await a.peer.startOffer();

    a.peer.close();
    a.peer.close(); // must not double-remove or throw

    deliver(answerFrom('peer-a', 'sdp-late'));
    deliver(candidateFrom('peer-a', 'cand-late'));
    await Promise.resolve();

    expect(a.pc.appliedRemoteSdps).toEqual([]);
    expect(a.pc.appliedCandidates).toEqual([]);
    expect(a.onError).not.toHaveBeenCalled();
    expect(listenerCount('answer')).toBe(0);
  });

  it('twenty connect/close cycles leave no listeners behind', () => {
    const { signaling, listenerCount } = sharedSignaling();
    for (let i = 0; i < 20; i++) {
      const p = shopPeerFor(signaling, `peer-${i}`);
      p.peer.close();
    }
    expect(listenerCount('answer')).toBe(0);
    expect(listenerCount('ice_candidate')).toBe(0);
    expect(listenerCount('offer')).toBe(0);
  });
});

describe('the customer side stays permissive until it knows the shop', () => {
  function customerPeer(signaling: SignalingClient) {
    const onError = vi.fn();
    const peer = new WebRTCPeer({
      role: 'customer',
      signalingClient: signaling,
      iceServers: [],
      onDataChannelReady: () => {},
      onError,
    });
    return { peer, pc: peer.peerConnection as unknown as MockPeerConnection, onError };
  }

  it('answers the first OFFER and locks onto that peerId', async () => {
    const { signaling, deliver } = sharedSignaling();
    const customer = customerPeer(signaling);

    deliver({ type: 'OFFER', sdp: { type: 'offer', sdp: 'shop-offer' }, fromPeerId: 'peer-shop' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(customer.pc.appliedRemoteSdps).toEqual(['shop-offer']);
    expect(customer.onError).not.toHaveBeenCalled();

    // Locked on: another peer's candidates are now refused.
    deliver(candidateFrom('peer-shop', 'cand-shop'));
    deliver(candidateFrom('peer-someone-else', 'cand-other'));
    await Promise.resolve();
    expect(customer.pc.appliedCandidates).toEqual(['cand-shop']);
  });

  it('ignores a second OFFER instead of renegotiating into a wrong-state crash', async () => {
    const { signaling, deliver } = sharedSignaling();
    const customer = customerPeer(signaling);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const sdp of ['shop-offer-1', 'shop-offer-2']) {
      deliver({ type: 'OFFER', sdp: { type: 'offer', sdp }, fromPeerId: 'peer-shop' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }

    expect(customer.pc.appliedRemoteSdps).toEqual(['shop-offer-1']);
    expect(customer.onError).not.toHaveBeenCalled();
    expect(customer.peer.getState()).not.toBe('FAILED');
    warn.mockRestore();
  });

  it('never answers an offer meant for the shop role', async () => {
    const { signaling, deliver } = sharedSignaling();
    const shop = shopPeerFor(signaling, 'peer-a');

    deliver({ type: 'OFFER', sdp: { type: 'offer', sdp: 'not-for-shop' }, fromPeerId: 'peer-a' });
    await Promise.resolve();

    expect(shop.pc.appliedRemoteSdps).toEqual([]);
  });
});
