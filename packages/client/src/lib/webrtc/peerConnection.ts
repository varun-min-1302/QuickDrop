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

  private setupSignalingListeners() {
    this.signaling.on('offer', async ({ sdp, fromPeerId }) => {
      if (this.role !== 'customer') return;

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
    });

    this.signaling.on('answer', async ({ sdp }) => {
      if (this.role === 'shop') {
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
          this.hasRemoteDescription = true;
          await this.drainPendingIceCandidates();
        } catch (err: any) {
          console.error('Failed to handle SDP answer:', err);
          this.setState('FAILED');
          if (this.options.onError) this.options.onError(err);
        }
      }
    });

    this.signaling.on('ice_candidate', async ({ candidate }) => {
      try {
        if (this.hasRemoteDescription) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } else {
          this.pendingIceCandidates.push(candidate);
        }
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    });
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
    this.setState('CLOSED');
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    this.peerConnection.close();
  }
}
