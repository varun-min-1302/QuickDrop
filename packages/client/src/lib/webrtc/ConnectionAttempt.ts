import { IceServerConfig } from '@quickdrop/shared';
import { SignalingClient } from './signalingClient.js';
import { WebRTCPeer } from './peerConnection.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionStage =
  | 'IDLE'
  | 'CONNECTING_WEBSOCKET'
  | 'JOINING_SESSION'
  | 'WAITING_FOR_SHOP'
  | 'NEGOTIATING_WEBRTC'
  | 'WAITING_FOR_ICE'
  | 'WAITING_FOR_DATA_CHANNEL'
  | 'CONNECTED'
  | 'FAILED'
  | 'SESSION_EXPIRED'
  | 'SESSION_NOT_FOUND'
  | 'INTERRUPTED';

export interface ConnectionAttemptCallbacks {
  onStageChange: (stage: ConnectionStage) => void;
  /** Fires as soon as JOIN_ACCEPTED arrives with customerCode/batchId */
  onSessionData: (customerCode: string, batchId: string) => void;
  /** Fires only when the DataChannel actually opens */
  onConnected: (channel: RTCDataChannel, customerCode: string, batchId: string) => void;
  /** Fires on any terminal failure */
  onFailed: (stage: ConnectionStage, detail: string) => void;
  /** Fires when session_expired or session_closed arrives post-connect */
  onSessionEnded: (reason: 'SESSION_EXPIRED' | 'SESSION_CLOSED') => void;
}

export interface ConnectionAttemptOptions {
  attemptId: number;
  /** Returns true if this is still the current attempt */
  isCurrentAttempt: () => boolean;
  joinToken: string;
  numericCode?: string;
  clientId?: string;
  callbacks: ConnectionAttemptCallbacks;
  /** Optional factories for DI / testing */
  signalingClientFactory?: () => SignalingClient;
  webRTCPeerFactory?: (opts: ConstructorParameters<typeof WebRTCPeer>[0]) => WebRTCPeer;
}

// ─── Timeouts ─────────────────────────────────────────────────────────────────

const TIMEOUT = {
  WEBSOCKET: 10_000,
  JOIN: 10_000,
  WAITING_FOR_SHOP: 15_000,
  NEGOTIATION: 15_000,
  ICE: 15_000,
  DATA_CHANNEL: 10_000,
  TOTAL: 30_000,
} as const;

// ─── ConnectionAttempt ────────────────────────────────────────────────────────

export class ConnectionAttempt {
  private aborted = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private signaling: SignalingClient | null = null;
  private peer: WebRTCPeer | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private options: ConnectionAttemptOptions;

  constructor(options: ConnectionAttemptOptions) {
    this.options = options;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private log(msg: string) {
    console.log(`[QuickDrop][CONNECT][attempt=${this.options.attemptId}] ${msg}`);
  }

  private setStage(stage: ConnectionStage) {
    if (this.aborted) return;
    if (!this.options.isCurrentAttempt()) return;
    this.options.callbacks.onStageChange(stage);
  }

  private addTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.aborted && this.options.isCurrentAttempt()) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    if (this.totalTimer) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
  }

  /** Immediately stops this attempt and cleans up all resources. Idempotent. */
  public abort(reason = 'aborted') {
    if (this.aborted) return;
    this.aborted = true;
    this.clearTimers();
    try { this.peer?.close(); } catch {}
    this.peer = null;
    try { this.signaling?.close(); } catch {}
    this.signaling = null;
    this.log(`ABORTED reason=${reason}`);
  }

  /** The underlying SignalingClient — only valid after onConnected fires. */
  public getSignalingClient(): SignalingClient | null {
    return this.signaling;
  }

  private fail(stage: ConnectionStage, detail: string) {
    if (this.aborted) return;
    this.log(`FAILED stage=${stage} detail=${detail}`);
    const cb = this.options.callbacks.onFailed;
    const isCurrent = this.options.isCurrentAttempt();
    this.abort('fail');
    if (isCurrent) cb(stage, detail);
  }

  // ─── Main flow ──────────────────────────────────────────────────────────────

  public async start() {
    const { joinToken, numericCode, clientId } = this.options;
    this.log(`START token=${joinToken.slice(0, 8)}...`);

    // Hard 30-second cap over the entire attempt
    this.totalTimer = setTimeout(() => {
      if (!this.aborted) {
        this.log('TOTAL_TIMEOUT');
        this.fail('INTERRUPTED', "Couldn't connect to the shop. Please try again.");
      }
    }, TIMEOUT.TOTAL);

    // ── Stage 1: WebSocket ───────────────────────────────────────────────────
    this.setStage('CONNECTING_WEBSOCKET');
    this.log('WS_CONNECTING');

    const factory = this.options.signalingClientFactory ?? (() => new SignalingClient());
    const signaling = factory();
    // This attempt owns the socket lifecycle (its own timeouts, abort, retry).
    // Disable the client's internal auto-reconnect/rejoin so a transient WS blip
    // during negotiation can't trigger a server-side reconnect and a duplicate OFFER.
    signaling.autoReconnect = false;
    this.signaling = signaling;

    const wsResult = await new Promise<'ok' | 'timeout' | 'error'>((resolve) => {
      const timer = this.addTimer(() => {
        this.log('WS_TIMEOUT');
        resolve('timeout');
      }, TIMEOUT.WEBSOCKET);

      signaling.connect()
        .then(() => { clearTimeout(timer); this.timers.delete(timer); resolve('ok'); })
        .catch(() => { clearTimeout(timer); this.timers.delete(timer); resolve('error'); });
    });

    if (this.aborted) return;

    if (wsResult !== 'ok') {
      this.fail('INTERRUPTED',
        wsResult === 'timeout'
          ? 'Server connection timed out. Check your internet connection.'
          : 'Could not connect to the QuickDrop server.');
      return;
    }
    this.log('WS_OPEN');

    // ── Stage 2: JOIN ────────────────────────────────────────────────────────
    this.setStage('JOINING_SESSION');
    this.log('JOIN_SENT');

    type JoinResult = 'accepted' | 'rejected' | 'expired' | 'not_found' | 'timeout';
    interface JoinData { customerCode?: string; batchId?: string; iceServers: IceServerConfig[] }
    let resolveJoin: ((v: JoinResult) => void) | null = null;
    let joinData: JoinData | null = null;

    const onJoinAccepted = (data: any) => {
      joinData = { customerCode: data.customerCode, batchId: data.batchId, iceServers: data.iceServers ?? [] };
      resolveJoin?.('accepted');
    };
    const onJoinRejected = (data: { code: string }) => {
      if (data.code === 'SESSION_EXPIRED') resolveJoin?.('expired');
      else if (data.code === 'SESSION_NOT_FOUND') resolveJoin?.('not_found');
      else resolveJoin?.('rejected');
    };

    signaling.on('join_accepted', onJoinAccepted);
    signaling.on('join_rejected', onJoinRejected);

    signaling.join({ role: 'customer', token: joinToken, numericCode, clientId });

    const joinResult = await new Promise<JoinResult>((resolve) => {
      resolveJoin = resolve;
      this.addTimer(() => { this.log('JOIN_TIMEOUT'); resolve('timeout'); }, TIMEOUT.JOIN);
    });
    resolveJoin = null;
    signaling.off('join_accepted', onJoinAccepted);
    signaling.off('join_rejected', onJoinRejected);

    if (this.aborted) return;

    if (joinResult !== 'accepted') {
      if (joinResult === 'expired') {
        this.fail('SESSION_EXPIRED', 'This session has expired. Please scan the QR code again.');
      } else if (joinResult === 'not_found') {
        this.fail('SESSION_NOT_FOUND', 'Session not found. Please scan the QR code at the shop.');
      } else if (joinResult === 'timeout') {
        this.fail('INTERRUPTED', 'Server did not respond to join request. Please retry.');
      } else {
        this.fail('INTERRUPTED', 'Could not join this session.');
      }
      return;
    }

    // joinData is guaranteed non-null here (joinResult === 'accepted' sets it)
    const joinedData = joinData!;
    this.log(`JOIN_ACK customerCode=${joinedData.customerCode}`);

    // Surface session data immediately so the customer code can be displayed
    if (joinedData.customerCode && joinedData.batchId && this.options.isCurrentAttempt()) {
      this.options.callbacks.onSessionData(joinedData.customerCode, joinedData.batchId);
    }

    // ── Stage 3: Wait for shop ───────────────────────────────────────────────
    this.setStage('WAITING_FOR_SHOP');
    this.log('WAITING_FOR_SHOP');

    let resolveShop: ((peerId: string | 'timeout') => void) | null = null;
    const onPeerJoined = (data: any) => {
      if (data.role === 'shop') resolveShop?.(data.peerId);
    };
    signaling.on('peer_joined', onPeerJoined);

    const shopPeerId = await new Promise<string | 'timeout'>((resolve) => {
      resolveShop = resolve;
      this.addTimer(() => { this.log('SHOP_TIMEOUT'); resolve('timeout'); }, TIMEOUT.WAITING_FOR_SHOP);
    });
    resolveShop = null;
    signaling.off('peer_joined', onPeerJoined);

    if (this.aborted) return;

    if (shopPeerId === 'timeout') {
      this.fail('INTERRUPTED',
        'The shop is not ready yet. Please ask the shop to open their dashboard and try again.');
      return;
    }
    this.log(`SHOP_PRESENT peerId=${shopPeerId}`);

    // ── Stage 4–6: WebRTC negotiation → ICE → DataChannel ───────────────────
    this.setStage('NEGOTIATING_WEBRTC');
    this.log('WEBRTC_START');

    const iceServers = joinedData.iceServers ?? [];

    type DCResult = RTCDataChannel | 'timeout' | 'ice_failed' | 'error';
    let resolveDC: ((r: DCResult) => void) | null = null;

    // Offer/answer timeout
    const negTimer = this.addTimer(() => {
      this.log('NEGOTIATION_TIMEOUT');
      resolveDC?.('timeout');
    }, TIMEOUT.NEGOTIATION);

    let iceTimerRef: ReturnType<typeof setTimeout> | null = null;

    const peerFactory = this.options.webRTCPeerFactory ?? ((opts) => new WebRTCPeer(opts));
    const peer = peerFactory({
      role: 'customer',
      signalingClient: signaling,
      iceServers,
      onDataChannelReady: (channel) => {
        this.log('DATACHANNEL_OPEN');
        if (iceTimerRef) { clearTimeout(iceTimerRef); this.timers.delete(iceTimerRef); }
        clearTimeout(negTimer);
        this.timers.delete(negTimer);
        resolveDC?.(channel);
      },
      onConnectionStateChange: (state) => {
        this.log(`RTC_STATE=${state}`);
        if (state === 'failed') {
          // If the overall connection state fails, it's typically an ICE or DTLS failure (network blocking).
          resolveDC?.('ice_failed');
        }
      },
      onDataChannelClosed: () => {
        this.log('DATACHANNEL_CLOSED');
      },
      onError: (err) => {
        this.log(`RTC_ERROR ${err.message}`);
        resolveDC?.(`error: ${err.message}` as any);
      },
    });
    this.peer = peer;

    // Monitor ICE state for finer-grained progress
    peer.peerConnection.oniceconnectionstatechange = () => {
      const iceState = peer.peerConnection.iceConnectionState;
      this.log(`ICE_STATE=${iceState}`);
      if (iceState === 'checking') {
        this.setStage('WAITING_FOR_ICE');
        // Start ICE-specific timer
        if (iceTimerRef) { clearTimeout(iceTimerRef); this.timers.delete(iceTimerRef); }
        iceTimerRef = this.addTimer(() => {
          this.log('ICE_TIMEOUT');
          resolveDC?.('timeout');
        }, TIMEOUT.ICE);
      } else if (iceState === 'connected' || iceState === 'completed') {
        if (iceTimerRef) { clearTimeout(iceTimerRef); this.timers.delete(iceTimerRef); }
        clearTimeout(negTimer);
        this.timers.delete(negTimer);
        // Start DataChannel-specific timer
        this.setStage('WAITING_FOR_DATA_CHANNEL');
        const dcTimer = this.addTimer(() => {
          this.log('DATACHANNEL_TIMEOUT');
          resolveDC?.('timeout');
        }, TIMEOUT.DATA_CHANNEL);
        this.timers.add(dcTimer);
      } else if (iceState === 'failed') {
        this.log('ICE_FAILED');
        resolveDC?.('ice_failed');
      }
    };

    // Also listen for post-connect session expiry
    const onSessionExpired = () => {
      this.log('SESSION_EXPIRED_POST_CONNECT');
      const cb = this.options.callbacks.onSessionEnded;
      const isCurrent = this.options.isCurrentAttempt();
      this.abort('session_expired');
      if (isCurrent) cb('SESSION_EXPIRED');
    };
    const onSessionClosed = () => {
      this.log('SESSION_CLOSED_POST_CONNECT');
      const cb = this.options.callbacks.onSessionEnded;
      const isCurrent = this.options.isCurrentAttempt();
      this.abort('session_closed');
      if (isCurrent) cb('SESSION_CLOSED');
    };
    signaling.on('session_expired', onSessionExpired);
    signaling.on('session_closed', onSessionClosed);

    const dcResult = await new Promise<DCResult>((resolve) => {
      resolveDC = resolve;
    });
    resolveDC = null;
    signaling.off('session_expired', onSessionExpired);
    signaling.off('session_closed', onSessionClosed);

    if (this.aborted) return;

    // Duck-type check: a real RTCDataChannel has a `readyState` property.
    // Using instanceof fails in Node.js test environments where RTCDataChannel is not globally defined.
    const isDC = dcResult !== null && typeof dcResult === 'object' && 'readyState' in dcResult;
    if (!isDC) {
      const detail =
        dcResult === 'ice_failed'
          ? 'Could not establish a direct P2P connection. Your network may be blocking it.'
          : dcResult === 'timeout'
          ? 'Connection timed out while establishing a secure channel.'
          : typeof dcResult === 'string' && dcResult.startsWith('error: ')
          ? `Connection error: ${dcResult.replace('error: ', '')}`
          : 'The secure connection was interrupted.';
      this.fail('INTERRUPTED', detail);
      return;
    }

    // ── SUCCESS ──────────────────────────────────────────────────────────────
    this.setStage('CONNECTED');
    this.log('CONNECTED');
    this.clearTimers(); // cancel total timer

    if (this.options.isCurrentAttempt()) {
      this.options.callbacks.onConnected(
        dcResult as RTCDataChannel,
        joinedData.customerCode ?? '',
        joinedData.batchId ?? '',
      );
    }
  }
}
