import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebRTCPeer } from '../lib/webrtc/peerConnection.js';
import { SignalingClient } from '../lib/webrtc/signalingClient.js';

// Mock WebRTC environment for Vitest Node.js runner
class MockRTCDataChannel {
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
    if (this.onclose) this.onclose();
  }
}

class MockRTCPeerConnection {
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public iceGatheringState: RTCIceGatheringState = 'new';
  public signalingState: RTCSignalingState = 'stable';
  public onicecandidate: ((event: any) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public ondatachannel: ((event: any) => void) | null = null;

  constructor(public config: any) {}

  createDataChannel(_label: string, _options: any) {
    const channel = new MockRTCDataChannel();
    return channel as any;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }

  async setLocalDescription(_desc: any) {}
  async setRemoteDescription(_desc: any) {}
  async addIceCandidate(_candidate: any) {}
  close() {
    this.connectionState = 'closed';
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }
}

describe('Phase 3 Real WebRTC Peer & DataChannel Architecture', () => {
  beforeEach(() => {
    (global as any).RTCPeerConnection = MockRTCPeerConnection;
    (global as any).RTCSessionDescription = function (desc: any) { return desc; };
    (global as any).RTCIceCandidate = function (cand: any) { return cand; };
  });

  it('initializes shop WebRTCPeer with ordered DataChannel and STUN configuration', () => {
    const mockSignaling = new SignalingClient('ws://localhost:3000/ws');
    const onDataChannelReady = vi.fn();

    const peer = new WebRTCPeer({
      role: 'shop',
      signalingClient: mockSignaling,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      onDataChannelReady,
    });

    expect(peer.peerConnection).toBeDefined();
    expect(peer.dataChannel).toBeDefined();
    expect(peer.getState()).toBe('CONNECTING');

    const diag = peer.getDiagnostics();
    expect(diag.connectionState).toBe('new');
    expect(diag.signalingState).toBe('stable');
    expect(diag.dataChannelReadyState).toBe('connecting');
  });

  it('triggers onDataChannelReady callback when DataChannel opens', () => {
    const mockSignaling = new SignalingClient('ws://localhost:3000/ws');
    const onDataChannelReady = vi.fn();
    const onStateChange = vi.fn();

    const peer = new WebRTCPeer({
      role: 'shop',
      signalingClient: mockSignaling,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      onDataChannelReady,
      onStateChange,
    });

    // Simulate DataChannel open event
    (peer.dataChannel as any).readyState = 'open';
    (peer.dataChannel as any).onopen();

    expect(onDataChannelReady).toHaveBeenCalledWith(peer.dataChannel);
    expect(peer.getState()).toBe('CONNECTED');
  });

  it('handles remote DataChannel on customer peer when offered by shop', () => {
    const mockSignaling = new SignalingClient('ws://localhost:3000/ws');
    const onDataChannelReady = vi.fn();

    const peer = new WebRTCPeer({
      role: 'customer',
      signalingClient: mockSignaling,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      onDataChannelReady,
    });

    expect(peer.dataChannel).toBeNull();

    // Simulate incoming ondatachannel event
    const inboundChannel = new MockRTCDataChannel();
    (peer.peerConnection as any).ondatachannel({ channel: inboundChannel });

    expect(peer.dataChannel).toBe(inboundChannel);

    inboundChannel.readyState = 'open';
    inboundChannel.onopen!();
    expect(onDataChannelReady).toHaveBeenCalledWith(inboundChannel);
    expect(peer.getState()).toBe('CONNECTED');
  });

  it('cleans up resources and transitions state to CLOSED on close()', () => {
    const mockSignaling = new SignalingClient('ws://localhost:3000/ws');
    const onDataChannelClosed = vi.fn();

    const peer = new WebRTCPeer({
      role: 'shop',
      signalingClient: mockSignaling,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      onDataChannelReady: () => {},
      onDataChannelClosed,
    });

    peer.close();
    expect(peer.getState()).toBe('CLOSED');
    expect(peer.dataChannel).toBeNull();
    expect(peer.peerConnection.connectionState).toBe('closed');
  });
});
