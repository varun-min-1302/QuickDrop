import {
  ClientSignalingMessage,
  ServerSignalingMessage,
  ServerSignalingMessageSchema,
  IceServerConfig,
} from '@quickdrop/shared';

export type SignalingEventMap = {
  join_accepted: (data: { sessionId: string; peerId: string; role: 'shop' | 'customer'; iceServers: IceServerConfig[]; expiresAt: number; customerCode?: string; batchId?: string; }) => void;
  join_rejected: (data: { code: string; reason: string }) => void;
  peer_joined: (data: { peerId: string; role: 'shop' | 'customer'; customer?: { clientId: string; customerCode: string; displayName?: string | null; batchId: string } }) => void;
  peer_left: (data: { peerId: string; role: 'shop' | 'customer'; clientId?: string; }) => void;
  customer_updated: (data: { peerId: string; clientId: string; displayName: string | null }) => void;
  batch_completed: (data: { peerId: string; clientId: string; }) => void;
  offer: (data: { sdp: RTCSessionDescriptionInit; fromPeerId: string }) => void;
  answer: (data: { sdp: RTCSessionDescriptionInit; fromPeerId: string }) => void;
  ice_candidate: (data: { candidate: RTCIceCandidateInit; fromPeerId: string }) => void;
  session_expired: (data: { reason?: string }) => void;
  session_closed: (data: { reason?: string }) => void;
  error: (data: { code: string; message: string }) => void;
  connection_state_change: (state: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void;
};

export class SignalingClient {
  private socket: WebSocket | null = null;
  private url: string;
  private listeners: Partial<{ [K in keyof SignalingEventMap]: Array<SignalingEventMap[K]> }> = {};
  private pingInterval?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 8000;
  private isIntentionallyClosed = false;
  /**
   * When false, the client will NOT automatically reconnect or re-JOIN after a
   * socket drop. The customer's ConnectionAttempt turns this off: an auto-rejoin
   * is treated by the server as a reconnect, which makes it re-notify the shop and
   * the shop send a fresh OFFER (and, on reconnect, close the existing peer) —
   * corrupting an in-flight negotiation or transfer. Higher-level code owns the
   * customer's reconnection instead. The shop keeps the default (true).
   */
  public autoReconnect = true;
  private lastJoinParams?: { role: 'shop' | 'customer'; token: string; sessionId?: string; numericCode?: string; clientId?: string };

  constructor(wsUrl?: string) {
    if (wsUrl) {
      this.url = wsUrl;
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${protocol}//${window.location.host}/ws`;
    }
  }

  public connect(): Promise<void> {
    this.isIntentionallyClosed = false;
    this.stopReconnect();
    this.emit('connection_state_change', this.reconnectAttempts > 0 ? 'RECONNECTING' : 'CONNECTING');

    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;

      try {
        if (this.socket) {
          try {
            this.socket.close();
          } catch {}
          this.socket = null;
        }

        const ws = new WebSocket(this.url);
        this.socket = ws;

        timeoutId = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            ws.close();
            reject(new Error("Connection timeout"));
          }
        }, 10000);

        ws.onopen = () => {
          clearTimeout(timeoutId);
          this.reconnectAttempts = 0;
          this.emit('connection_state_change', 'CONNECTED');
          this.startHeartbeat();

          // Auto-rejoin session if reconnected (unless disabled by the owner)
          if (this.autoReconnect && this.lastJoinParams) {
            this.join(this.lastJoinParams);
          }

          resolve();
        };

        ws.onmessage = (event) => {
          try {
            const raw = JSON.parse(event.data);
            const parsed = ServerSignalingMessageSchema.safeParse(raw);
            if (!parsed.success) {
              console.warn('Signaling message schema error:', parsed.error);
              return;
            }
            this.handleMessage(parsed.data);
          } catch (err) {
            console.error('Failed to parse signaling message:', err);
          }
        };

        ws.onerror = (err) => {
          clearTimeout(timeoutId);
          if (this.reconnectAttempts === 0) {
            reject(err);
          }
        };

        ws.onclose = () => {
          clearTimeout(timeoutId);
          this.stopHeartbeat();
          if (!this.isIntentionallyClosed) {
            this.emit('connection_state_change', 'DISCONNECTED');
            this.scheduleReconnect();
          } else {
            this.emit('connection_state_change', 'DISCONNECTED');
          }
        };
      } catch (err) {
        this.scheduleReconnect();
        reject(err);
      }
    });
  }

  private scheduleReconnect() {
    if (this.isIntentionallyClosed || this.reconnectTimer || !this.autoReconnect) return;

    this.emit('connection_state_change', 'RECONNECTING');
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.isIntentionallyClosed) {
        this.connect().catch(() => {
          // Failure will trigger ws.onclose -> next scheduleReconnect
        });
      }
    }, delay);
  }

  private stopReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  public on<K extends keyof SignalingEventMap>(event: K, handler: SignalingEventMap[K]) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    (this.listeners[event] as Array<SignalingEventMap[K]>).push(handler);
  }

  public off<K extends keyof SignalingEventMap>(event: K, handler: SignalingEventMap[K]) {
    const list = this.listeners[event];
    if (!list) return;
    this.listeners[event] = (list as Array<SignalingEventMap[K]>).filter((h) => h !== handler) as any;
  }

  private emit<K extends keyof SignalingEventMap>(event: K, ...args: Parameters<SignalingEventMap[K]>) {
    const list = this.listeners[event];
    if (list) {
      for (const listener of list) {
        (listener as any)(...args);
      }
    }
  }

  public join(params: { role: 'shop' | 'customer'; token: string; sessionId?: string; numericCode?: string; clientId?: string }) {
    this.lastJoinParams = params;
    this.send({
      type: 'JOIN',
      role: params.role,
      token: params.token,
      sessionId: params.sessionId,
      numericCode: params.numericCode,
      clientId: params.clientId,
      protocolVersion: '1.0',
    });
  }

  public sendOffer(sdp: RTCSessionDescriptionInit, targetPeerId?: string) {
    this.send({
      type: 'OFFER',
      sdp: {
        type: sdp.type as 'offer',
        sdp: sdp.sdp || '',
      },
      targetPeerId,
    });
  }

  public sendAnswer(sdp: RTCSessionDescriptionInit, targetPeerId?: string) {
    this.send({
      type: 'ANSWER',
      sdp: {
        type: sdp.type as 'answer',
        sdp: sdp.sdp || '',
      },
      targetPeerId,
    });
  }

  public sendIceCandidate(candidate: RTCIceCandidateInit, targetPeerId?: string) {
    this.send({
      type: 'ICE_CANDIDATE',
      candidate: {
        candidate: candidate.candidate || '',
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      },
      targetPeerId,
    });
  }

  private send(msg: ClientSignalingMessage) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  public updateCustomer(displayName: string | null) {
    this.send({
      type: 'CUSTOMER_UPDATED',
      displayName,
    });
  }

  public batchCompleted() {
    this.send({
      type: 'BATCH_COMPLETED',
    });
  }

  private handleMessage(msg: ServerSignalingMessage) {
    switch (msg.type) {
      case 'JOIN_ACCEPTED':
        this.emit('join_accepted', {
          sessionId: msg.sessionId,
          role: msg.role,
          peerId: msg.peerId,
          iceServers: msg.iceServers,
          expiresAt: msg.expiresAt,
          customerCode: msg.customerCode,
          batchId: msg.batchId,
        });
        break;

      case 'JOIN_REJECTED':
        this.emit('join_rejected', {
          code: msg.code,
          reason: msg.reason,
        });
        break;

      case 'PEER_JOINED':
        this.emit('peer_joined', { peerId: msg.peerId, role: msg.role, customer: msg.customer });
        break;

      case 'CUSTOMER_UPDATED':
        this.emit('customer_updated', { peerId: msg.peerId, clientId: msg.clientId, displayName: msg.displayName });
        break;

      case 'PEER_LEFT':
        this.emit('peer_left', { peerId: msg.peerId, role: msg.role, clientId: msg.clientId });
        break;

      case 'BATCH_COMPLETED':
        this.emit('batch_completed', { peerId: msg.peerId, clientId: msg.clientId });
        break;

      case 'OFFER':
        this.emit('offer', { sdp: msg.sdp, fromPeerId: msg.fromPeerId });
        break;

      case 'ANSWER':
        this.emit('answer', { sdp: msg.sdp, fromPeerId: msg.fromPeerId });
        break;

      case 'ICE_CANDIDATE':
        this.emit('ice_candidate', { candidate: msg.candidate, fromPeerId: msg.fromPeerId });
        break;

      case 'SESSION_EXPIRED':
        this.emit('session_expired', { reason: msg.reason });
        break;

      case 'SESSION_CLOSED':
        this.emit('session_closed', { reason: msg.reason });
        break;

      case 'ERROR':
        this.emit('error', { code: msg.code, message: msg.message });
        break;

      case 'PONG':
        break;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      this.send({ type: 'PING' });
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  public close() {
    this.isIntentionallyClosed = true;
    this.stopReconnect();
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
  }
}
