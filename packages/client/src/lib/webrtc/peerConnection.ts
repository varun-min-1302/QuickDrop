import { IceServerConfig } from '@quickdrop/shared';
import { SignalingClient } from './signalingClient.js';

export type WebRTCConnectionState =
  | 'IDLE'
  | 'JOINING'
  | 'SIGNALING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'FAILED'
  | 'CLOSED';

export interface WebRTCPeerDiagnostics {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  dataChannelReadyState: RTCDataChannelState;
  dataChannelBufferedAmount: number;
}

export interface WebRTCPeerOptions {
  role: 'shop' | 'customer';
  signalingClient: SignalingClient;
  iceServers: IceServerConfig[];
  targetPeerId?: string;
  onDataChannelReady: (channel: RTCDataChannel) => void;
  onDataChannelClosed?: () => void;
  onStateChange?: (state: WebRTCConnectionState) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onError?: (err: Error) => void;
}

export class WebRTCPeer {
  public peerConnection: RTCPeerConnection;
  public dataChannel: RTCDataChannel | null = null;
  private signaling: SignalingClient;
  private role: 'shop' | 'customer';
  private targetPeerId?: string;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  /** Reentrancy guard: an offer is currently being answered. */
  private isNegotiating = false;
  /** True once a full offer/answer exchange has completed for this peer. */
  private hasNegotiated = false;
  /** Set by close(); makes every signaling handler a no-op afterwards. */
  private isClosed = false;
  private options: WebRTCPeerOptions;
  private currentState: WebRTCConnectionState = 'IDLE';

  constructor(options: WebRTCPeerOptions) {
    this.options = options;
    this.role = options.role;
    this.signaling = options.signalingClient;
    this.targetPeerId = options.targetPeerId;

    const rtcConfig: RTCConfiguration = {
      iceServers: options.iceServers as RTCIceServer[],
      iceCandidatePoolSize: 2,
    };

    this.peerConnection = new RTCPeerConnection(rtcConfig);
    this.setState('CONNECTING');
    this.setupPeerConnection();
    this.setupSignalingListeners();

    if (this.role === 'shop') {
      // Shop initiates reliable ordered data channel
      this.initiateShopDataChannel();
    }
  }

  private setState(state: WebRTCConnectionState) {
    this.currentState = state;
    if (this.options.onStateChange) {
      this.options.onStateChange(state);
    }
  }

  public getState(): WebRTCConnectionState {
    return this.currentState;
  }

  public getDiagnostics(): WebRTCPeerDiagnostics {
    return {
      connectionState: this.peerConnection.connectionState,
      iceConnectionState: this.peerConnection.iceConnectionState,
      iceGatheringState: this.peerConnection.iceGatheringState,
      signalingState: this.peerConnection.signalingState,
      dataChannelReadyState: this.dataChannel?.readyState ?? 'closed',
      dataChannelBufferedAmount: this.dataChannel?.bufferedAmount ?? 0,
    };
  }

  private setupPeerConnection() {
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(event.candidate.toJSON(), this.targetPeerId);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (this.options.onConnectionStateChange) {
        this.options.onConnectionStateChange(state);
      }

      switch (state) {
        case 'connecting':
          this.setState('CONNECTING');
          break;
        case 'connected':
          if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.setState('CONNECTED');
          } else {
            this.setState('SIGNALING');
          }
          break;
        case 'disconnected':
          this.setState('RECONNECTING');
          break;
        case 'failed':
          this.setState('FAILED');
          break;
        case 'closed':
          this.setState('CLOSED');
          break;
      }
    };

    this.peerConnection.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };
  }

  private initiateShopDataChannel() {
    const channel = this.peerConnection.createDataChannel('quickdrop-transfer', {
      ordered: true,
    });
    this.setupDataChannel(channel);
  }

  private setupDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      this.setState('CONNECTED');
      this.options.onDataChannelReady(channel);
    };

    channel.onclose = () => {
      if (this.currentState !== 'CLOSED') {
        this.setState('CLOSED');
      }
      if (this.options.onDataChannelClosed) {
        this.options.onDataChannelClosed();
      }
    };

    channel.onerror = (err) => {
      console.error('WebRTC DataChannel error:', err);
    };
  }

  /**
   * Is a signaling message that arrived from `fromPeerId` addressed to THIS peer?
   *
   * This is the single most important guard in the shop's multi-customer path. The
   * shop runs one WebRTCPeer per customer, but they all share ONE SignalingClient,
   * and `SignalingClient.emit` fans every message out to every registered listener.
   * Unfiltered, customer B's ANSWER was applied to A's and C's peers as well:
   *   • A, already `stable`, threw "Called in wrong state: stable" — surfacing a
   *     spurious error against A and tearing down A's healthy connection.
   *   • C, still in `have-local-offer`, *accepted* B's SDP and then negotiated
   *     against the wrong DTLS fingerprint, so C's DataChannel never opened.
   * Which customer broke depended purely on message interleaving, which is why it
   * looked random on real devices and could never reproduce with a single phone.
   *
   * The shop always knows its counterpart (`targetPeerId` is set at construction).
   * A customer does not learn the shop's peerId until the first OFFER arrives and
   * owns a dedicated socket with exactly one counterpart, so it stays permissive
   * until it has locked on. `fromPeerId` is always stamped by the server's relay;
   * a missing value only occurs in unit tests, where being permissive is harmless.
   */
  private isFromMyPeer(fromPeerId: string | undefined): boolean {
    if (this.isClosed) return false;
    if (!this.targetPeerId || !fromPeerId) return true;
    return fromPeerId === this.targetPeerId;
  }

  private onSignalingOffer = async ({ sdp, fromPeerId }: { sdp: RTCSessionDescriptionInit; fromPeerId: string }) => {
    if (this.role !== 'customer' || this.isClosed) return;

    // The customer is the sole answerer and negotiates exactly once — the shop
    // never renegotiates in this architecture. A second offer can still arrive
    // (a shop-side signaling-listener leak, or a WebSocket blip that triggers a
    // server-side reconnect and a fresh offer). Answering it would race the
    // first handler: the peer connection returns to `stable` mid-flight, and the
    // second setLocalDescription throws
    // "Failed to set local answer sdp: Called in wrong state: stable".
    // Ignore any offer that arrives while we're mid-negotiation or already done.
    if (this.isNegotiating || this.hasNegotiated) {
      console.warn('WebRTCPeer: ignoring duplicate SDP offer (negotiation already in progress or complete).');
      return;
    }
    this.isNegotiating = true;
    this.targetPeerId = fromPeerId;
    this.setState('SIGNALING');
    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      this.hasRemoteDescription = true;
      await this.drainPendingIceCandidates();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      this.hasNegotiated = true;

      this.signaling.sendAnswer(
        { type: answer.type, sdp: answer.sdp || '' },
        this.targetPeerId
      );
    } catch (err: any) {
      console.error('Failed to handle SDP offer:', err);
      this.setState('FAILED');
      if (this.options.onError) this.options.onError(err);
    } finally {
      this.isNegotiating = false;
    }
  };

  private onSignalingAnswer = async ({ sdp, fromPeerId }: { sdp: RTCSessionDescriptionInit; fromPeerId: string }) => {
    if (this.role !== 'shop' || this.isClosed) return;
    // Belt: only the peer this answer is addressed to may consume it.
    if (!this.isFromMyPeer(fromPeerId)) return;
    // Braces: independent of routing, a peer that is not waiting for an answer can
    // never legitimately apply one. Without this, any future routing regression
    // silently corrupts a live connection instead of being ignored.
    if (this.peerConnection.signalingState !== 'have-local-offer') {
      console.warn(
        `WebRTCPeer: ignoring ANSWER in signalingState=${this.peerConnection.signalingState} (not awaiting one).`,
      );
      return;
    }
    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      this.hasRemoteDescription = true;
      await this.drainPendingIceCandidates();
    } catch (err: any) {
      console.error('Failed to handle SDP answer:', err);
      this.setState('FAILED');
      if (this.options.onError) this.options.onError(err);
    }
  };

  private onSignalingIceCandidate = async ({ candidate, fromPeerId }: { candidate: RTCIceCandidateInit; fromPeerId: string }) => {
    // Cross-injected candidates pollute every other customer's candidate pool and
    // make connectivity checks fail or crawl; drop anything not from our peer.
    if (!this.isFromMyPeer(fromPeerId)) return;
    try {
      if (this.hasRemoteDescription) {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        this.pendingIceCandidates.push(candidate);
      }
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  };

  private setupSignalingListeners() {
    this.signaling.on('offer', this.onSignalingOffer);
    this.signaling.on('answer', this.onSignalingAnswer);
    this.signaling.on('ice_candidate', this.onSignalingIceCandidate);
  }

  /**
   * Removes exactly the handlers registered above. Previously these were inline
   * arrows that could never be removed, so on the shop's shared SignalingClient
   * every closed/replaced peer kept reacting to live traffic forever — one leaked
   * handler set per customer reconnect.
   */
  private teardownSignalingListeners() {
    this.signaling.off('offer', this.onSignalingOffer);
    this.signaling.off('answer', this.onSignalingAnswer);
    this.signaling.off('ice_candidate', this.onSignalingIceCandidate);
  }

  public async startOffer(targetPeerId?: string) {
    if (targetPeerId) this.targetPeerId = targetPeerId;
    this.setState('SIGNALING');
    try {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.signaling.sendOffer(
        { type: offer.type, sdp: offer.sdp || '' },
        this.targetPeerId
      );
    } catch (err: any) {
      console.error('Error creating SDP offer:', err);
      this.setState('FAILED');
      if (this.options.onError) this.options.onError(err);
    }
  }

  public async restartIce() {
    this.setState('RECONNECTING');
    try {
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      this.signaling.sendOffer(
        { type: offer.type, sdp: offer.sdp || '' },
        this.targetPeerId
      );
    } catch (err: any) {
      console.error('Error restarting ICE:', err);
      this.setState('FAILED');
    }
  }

  private async drainPendingIceCandidates() {
    while (this.pendingIceCandidates.length > 0) {
      const candidate = this.pendingIceCandidates.shift();
      if (candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('Failed to add queued ICE candidate:', err);
        }
      }
    }
  }

  public close() {
    if (this.isClosed) return;
    // Detach from the (possibly shared) SignalingClient FIRST so a message that is
    // already queued cannot be applied to a connection we are tearing down.
    this.isClosed = true;
    this.teardownSignalingListeners();
    this.setState('CLOSED');
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    this.peerConnection.close();
  }
}
