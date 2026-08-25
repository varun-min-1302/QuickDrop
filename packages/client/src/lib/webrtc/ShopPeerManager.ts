import { IceServerConfig, TransferProgress, DataChannelControlMessage } from '@quickdrop/shared';
import { SignalingClient, SignalingEventMap } from './signalingClient.js';
import { WebRTCPeer } from './peerConnection.js';
import { FileReceiver, ReceivedDocument } from '../transfer/receiver.js';
import { isDiagnosticsEnabled, setDiagnosticsEnabled } from '../diagnostics.js';

/**
 * A received document as the SHOP knows it: the receiver's payload plus durable
 * customer attribution. Every field the dashboard needs in order to name the owner
 * travels WITH the document, so a document can always describe its customer even if
 * it is rendered outside that customer's group or the customer has since dropped.
 */
export interface ShopDocument extends ReceivedDocument {
  clientId: string;
  batchId: string;
  customerCode: string;
  displayName: string | null;
}

/**
 * Where a customer's batch stands. Derived from transfers + documents on every
 * change, never set speculatively, so it can't drift out of step with the queue.
 */
export type BatchStatus = 'EMPTY' | 'RECEIVING' | 'READY_TO_PRINT' | 'COMPLETED';

export interface CustomerSession {
  clientId: string;
  peerId: string;
  customerCode: string;
  batchId: string;
  batchStatus: BatchStatus;
  displayName: string | null;
  connectionState: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';
  peer: WebRTCPeer;
  receiver: FileReceiver | null;
  transfers: Map<string, TransferProgress>;
  /**
   * Everything this customer has successfully sent, keyed by documentId. This is the
   * authoritative record of the customer→documents relationship; the dashboard's
   * React state is a projection of it, never the source of truth.
   */
  documents: Map<string, ShopDocument>;
}

export interface ShopPeerManagerEvents {
  onCustomerJoined?: (customer: CustomerSession) => void;
  onCustomerUpdated?: (customer: CustomerSession) => void;
  onCustomerLeft?: (clientId: string) => void;
  onConnectionStateChange?: (clientId: string, state: CustomerSession['connectionState']) => void;
  onTransferProgress?: (clientId: string, progress: TransferProgress) => void;
  onFileReceived?: (clientId: string, doc: ShopDocument) => void;
  onError?: (clientId: string, error: string) => void;
}

/**
 * Every way a transfer can reach a terminal state. ALL of these must release the
 * queue lease — that is the invariant this module exists to guarantee.
 */
export type TransferTerminalReason =
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'USER_CANCELLED'
  | 'CHECKSUM_MISMATCH'
  | 'FILE_REJECTED'
  | 'PEER_DISCONNECTED'
  | 'DATA_CHANNEL_CLOSED'
  | 'WEBRTC_FAILED'
  | 'SHOP_VERIFICATION_TIMEOUT'
  | 'SESSION_EXPIRED'
  | 'SESSION_CLOSED'
  | 'NETWORK_ERROR';

type LeaseState = 'QUEUED' | 'ACTIVE' | 'FINALIZED';

/**
 * A queue lease represents one customer file's claim on the shop's single
 * active-transfer slot. Leases are keyed by transferId and always carry clientId,
 * so the global FIFO policy never loses track of which customer owns what.
 */
interface TransferLease {
  transferId: string;
  clientId: string;
  state: LeaseState;
  /**
   * Sends FILE_ACCEPT to the customer. Returns false if it could not be sent — a
   * closed DataChannel does not throw, so this return value is the only reliable
   * signal that the slot must be released rather than held.
   */
  accept: () => boolean | void;
  /** Sends TRANSFER_CANCEL to the customer so its sender stops waiting. */
  notifyCancel: (reason: string) => void;
  watchdog: ReturnType<typeof setTimeout> | null;
}

export interface ShopPeerManagerOptions {
  /** DI hook for tests. */
  webRTCPeerFactory?: (opts: ConstructorParameters<typeof WebRTCPeer>[0]) => WebRTCPeer;
  /**
   * Inactivity watchdog for an ACTIVE transfer. If no chunk/progress arrives for
   * this long, the shop assumes the customer died mid-transfer, cancels it, and
   * releases the slot. Backstop for the case where the customer cannot tell us.
   */
  transferWatchdogMs?: number;
  maxConcurrentTransfers?: number;
}

// ─── Dev-only structured tracing ───────────────────────────────────────────────
// Tagged, greppable, and OFF in production builds. These exist so a real-device
// multi-customer failure can be pinned to a stage from a phone's remote console
// instead of guessed at. Enable/disable at runtime with setTransferQueueLogging().

/** Silence or enable the [QD][…] trace logs (tests turn this off; prod is off). */
export const setTransferQueueLogging = setDiagnosticsEnabled;

export const isTransferQueueLoggingEnabled = isDiagnosticsEnabled;

const shortId = (id: string | undefined) => (id ? id.slice(0, 8) : 'none');

export class ShopPeerManager {
  private signaling: SignalingClient;
  private iceServers: IceServerConfig[];
  private customers = new Map<string, CustomerSession>();
  private events: ShopPeerManagerEvents;

  // ── Queue state ───────────────────────────────────────────────────────────
  // activeTransferCount is DERIVED from lease state rather than stored, which
  // makes double-decrement and negative counts structurally impossible.
  private leases = new Map<string, TransferLease>();
  private queueOrder: string[] = [];
  private isDequeuing = false;

  private maxConcurrentTransfers: number;
  private transferWatchdogMs: number;
  private peerFactory: (opts: ConstructorParameters<typeof WebRTCPeer>[0]) => WebRTCPeer;

  constructor(
    signaling: SignalingClient,
    iceServers: IceServerConfig[],
    events: ShopPeerManagerEvents,
    options: ShopPeerManagerOptions = {},
  ) {
    this.signaling = signaling;
    this.iceServers = iceServers;
    this.events = events;
    this.maxConcurrentTransfers = options.maxConcurrentTransfers ?? 1;
    this.transferWatchdogMs = options.transferWatchdogMs ?? 45_000;
    this.peerFactory = options.webRTCPeerFactory ?? ((opts) => new WebRTCPeer(opts));
    this.setupSignalingListeners();
  }

  private log(msg: string) {
    if (isDiagnosticsEnabled()) console.log(msg);
  }

  /** `[QD][QUEUE] active= queued= next=` */
  private logQueue(extra = '') {
    if (!isDiagnosticsEnabled()) return;
    const queued = this.getQueuedTransferIds();
    console.log(
      `[QD][QUEUE] active=${this.getActiveTransferCount()} queued=${queued.length} next=${shortId(queued[0])}${extra ? ' ' + extra : ''}`,
    );
  }

  /** `[QD][TRANSFER] clientId= batchId= transferId= fileName= state=` */
  private logTransfer(clientId: string, transferId: string, state: string, fileName = '') {
    if (!isDiagnosticsEnabled()) return;
    const cust = this.customers.get(clientId);
    const name = fileName || cust?.transfers.get(transferId)?.fileName || '';
    console.log(
      `[QD][TRANSFER] clientId=${shortId(clientId)} batchId=${shortId(cust?.batchId)} transferId=${shortId(transferId)} fileName=${name} state=${state}`,
    );
  }

  /** `[QD][CUSTOMER] clientId= peerId= customerCode= batchId=` */
  private logCustomer(cust: Pick<CustomerSession, 'clientId' | 'peerId' | 'customerCode' | 'batchId'>, event: string) {
    if (!isDiagnosticsEnabled()) return;
    console.log(
      `[QD][CUSTOMER] clientId=${shortId(cust.clientId)} peerId=${shortId(cust.peerId)} customerCode=${cust.customerCode} batchId=${shortId(cust.batchId)} event=${event}`,
    );
  }

  /** `[QD][WEBRTC] clientId= peerId= connectionState=` */
  private logWebrtc(clientId: string, peerId: string, connectionState: string) {
    if (!isDiagnosticsEnabled()) return;
    console.log(
      `[QD][WEBRTC] clientId=${shortId(clientId)} peerId=${shortId(peerId)} connectionState=${connectionState}`,
    );
  }

  /** `[QD][WS] clientId= peerId= event=` */
  private logWs(clientId: string | undefined, peerId: string | undefined, event: string) {
    if (!isDiagnosticsEnabled()) return;
    console.log(`[QD][WS] clientId=${shortId(clientId)} peerId=${shortId(peerId)} event=${event}`);
  }

  /**
   * Recompute batchStatus from the customer's own transfers + documents. Derived, so
   * it can never disagree with the queue about whether work is outstanding.
   */
  private refreshBatchStatus(cust: CustomerSession) {
    if (cust.batchStatus === 'COMPLETED') return;
    let inFlight = false;
    for (const lease of this.leases.values()) {
      if (lease.clientId === cust.clientId && lease.state !== 'FINALIZED') {
        inFlight = true;
        break;
      }
    }
    cust.batchStatus = inFlight
      ? 'RECEIVING'
      : cust.documents.size > 0
        ? 'READY_TO_PRINT'
        : 'EMPTY';
  }

  // ─── Signaling listeners ────────────────────────────────────────────────────
  // Stored handler references so the exact same functions can be removed in
  // cleanup(). Previously these were inline arrows registered but never removed —
  // every manager rebuild (e.g. a React effect re-run when iceServers arrived, or
  // StrictMode's double-invoke) stacked another listener set, so a single
  // customer join fired handleCustomerJoined N times and the shop sent N OFFERs.

  private onPeerJoined = (data: Parameters<SignalingEventMap['peer_joined']>[0]) => {
    if (data.role === 'customer' && data.customer) {
      this.logWs(data.customer.clientId, data.peerId, 'PEER_JOINED');
      this.handleCustomerJoined(data.peerId, data.customer);
    }
  };

  private onPeerLeft = (data: Parameters<SignalingEventMap['peer_left']>[0]) => {
    if (data.role === 'customer') {
      this.logWs(data.clientId, data.peerId, 'PEER_LEFT');
      this.handleCustomerLeftByPeerId(data.peerId, data.clientId);
    }
  };

  private onCustomerUpdatedEvent = (data: Parameters<SignalingEventMap['customer_updated']>[0]) => {
    const cust = this.customers.get(data.clientId || "");
    if (cust) {
      this.logWs(data.clientId, data.peerId, 'CUSTOMER_UPDATED');
      cust.displayName = data.displayName;
      this.events.onCustomerUpdated?.(cust);
    }
  };

  /**
   * The customer says its batch is done. Advisory only — it changes how the batch is
   * labelled for the operator and never touches the queue, so a malicious or buggy
   * customer cannot release another customer's slot with it.
   */
  private onBatchCompletedEvent = (data: Parameters<SignalingEventMap['batch_completed']>[0]) => {
    const cust = this.customers.get(data.clientId || '');
    if (!cust) return;
    this.logWs(data.clientId, data.peerId, 'BATCH_COMPLETED');
    if (cust.documents.size > 0) {
      cust.batchStatus = 'COMPLETED';
      this.events.onCustomerUpdated?.(cust);
    }
  };

  private setupSignalingListeners() {
    this.signaling.on('peer_joined', this.onPeerJoined);
    this.signaling.on('peer_left', this.onPeerLeft);
    this.signaling.on('customer_updated', this.onCustomerUpdatedEvent);
    this.signaling.on('batch_completed', this.onBatchCompletedEvent);
  }

  private teardownSignalingListeners() {
    this.signaling.off('peer_joined', this.onPeerJoined);
    this.signaling.off('peer_left', this.onPeerLeft);
    this.signaling.off('customer_updated', this.onCustomerUpdatedEvent);
    this.signaling.off('batch_completed', this.onBatchCompletedEvent);
  }

  /** Update the ICE servers used for peers created from here on (in place). */
  public setIceServers(iceServers: IceServerConfig[]) {
    this.iceServers = iceServers;
  }

  // ─── Queue: lease lifecycle ─────────────────────────────────────────────────

  /** Number of leases currently holding the active slot. Never negative. */
  public getActiveTransferCount(): number {
    let n = 0;
    for (const lease of this.leases.values()) {
      if (lease.state === 'ACTIVE') n++;
    }
    return n;
  }

  /** transferIds still waiting for a slot, in FIFO order. */
  public getQueuedTransferIds(): string[] {
    return this.queueOrder.filter((id) => this.leases.get(id)?.state === 'QUEUED');
  }

  public getLeaseState(transferId: string): LeaseState | undefined {
    return this.leases.get(transferId)?.state;
  }

  /**
   * Register a new file for the single active-transfer slot. Activates it
   * immediately if the slot is free, otherwise leaves it QUEUED in FIFO order.
   */
  private requestTransferSlot(
    clientId: string,
    transferId: string,
    accept: () => boolean | void,
    notifyCancel: (reason: string) => void,
  ) {
    const existing = this.leases.get(transferId);
    if (existing) {
      // Duplicate FILE_OFFER for a transferId we already track — never allow a
      // second lease for the same id (that would let one file take two slots).
      this.logTransfer(clientId, transferId, `DUPLICATE_OFFER_IGNORED(${existing.state})`);
      return;
    }

    this.leases.set(transferId, {
      transferId,
      clientId,
      state: 'QUEUED',
      accept,
      notifyCancel,
      watchdog: null,
    });
    this.queueOrder.push(transferId);
    this.logTransfer(clientId, transferId, 'QUEUED');
    this.logQueue();

    const cust = this.customers.get(clientId);
    if (cust) this.refreshBatchStatus(cust);

    this.tryDequeue();
  }

  /**
   * Idempotent terminal finalization. Safe to call any number of times with any
   * reason — only the FIRST call for a given transferId releases the slot.
   * This is the single choke point that guarantees the queue always progresses.
   */
  public finalizeTransfer(transferId: string, reason: TransferTerminalReason): boolean {
    const released = this.releaseLease(transferId, reason);
    // Always attempt to advance, even if this call was a no-op: a redundant
    // signal is a cheap opportunity to notice a slot that should be free.
    this.tryDequeue();
    return released;
  }

  /** Pure state transition — no dequeue, so it is safe to call from tryDequeue. */
  private releaseLease(transferId: string, reason: TransferTerminalReason): boolean {
    const lease = this.leases.get(transferId);
    if (!lease) {
      this.log(`[QD][QUEUE] finalize ignored (unknown) transfer=${shortId(transferId)} reason=${reason}`);
      return false;
    }
    if (lease.state === 'FINALIZED') {
      this.log(`[QD][QUEUE] finalize ignored (already final) transfer=${shortId(transferId)} reason=${reason}`);
      return false;
    }

    const wasActive = lease.state === 'ACTIVE';
    lease.state = 'FINALIZED';
    this.clearWatchdog(lease);

    this.logTransfer(lease.clientId, transferId, `FINALIZED(${reason}) wasActive=${wasActive}`);
    if (wasActive) this.logQueue('released=' + shortId(transferId));

    const cust = this.customers.get(lease.clientId);
    if (cust) this.refreshBatchStatus(cust);
    return true;
  }

  /** Promote queued leases into the active slot while capacity allows. */
  private tryDequeue() {
    if (this.isDequeuing) return;
    this.isDequeuing = true;
    try {
      while (this.getActiveTransferCount() < this.maxConcurrentTransfers) {
        const lease = this.shiftNextEligibleLease();
        if (!lease) break;
        this.activateLease(lease);
      }
    } finally {
      this.isDequeuing = false;
    }
  }

  /**
   * Pop the next QUEUED lease whose customer is still usable. Leases belonging to
   * departed customers are finalized and skipped rather than blocking the queue.
   */
  private shiftNextEligibleLease(): TransferLease | null {
    while (this.queueOrder.length > 0) {
      const transferId = this.queueOrder.shift()!;
      const lease = this.leases.get(transferId);

      // Already finalized (or gone) while sitting in the queue — skip.
      if (!lease || lease.state !== 'QUEUED') continue;

      const cust = this.customers.get(lease.clientId);
      if (!cust || cust.connectionState === 'DISCONNECTED') {
        this.logTransfer(lease.clientId, transferId, 'SKIPPED(customer_gone)');
        this.releaseLease(transferId, 'PEER_DISCONNECTED');
        continue;
      }

      return lease;
    }
    return null;
  }

  private activateLease(lease: TransferLease) {
    lease.state = 'ACTIVE';
    this.armWatchdog(lease);
    this.logTransfer(lease.clientId, lease.transferId, 'ACTIVE');
    this.logQueue('activated=' + shortId(lease.transferId));
    const cust = this.customers.get(lease.clientId);
    if (cust) this.refreshBatchStatus(cust);
    try {
      // `false` means FILE_ACCEPT never left (dead channel — which does NOT throw).
      // Treated exactly like a throw: the customer will never send a byte, so holding
      // the slot for the watchdog's full timeout would stall everyone behind them.
      if (lease.accept() === false) {
        this.logTransfer(lease.clientId, lease.transferId, 'ACCEPT_SEND_FAILED');
        this.releaseLease(lease.transferId, 'DATA_CHANNEL_CLOSED');
        this.events.onError?.(lease.clientId, 'Could not start the transfer — connection lost.');
      }
    } catch (err) {
      // If we cannot even send FILE_ACCEPT the slot must not stay held.
      this.logTransfer(lease.clientId, lease.transferId, 'ACCEPT_SEND_FAILED');
      this.releaseLease(lease.transferId, 'NETWORK_ERROR');
      this.events.onError?.(lease.clientId, (err as Error)?.message || 'Failed to accept transfer');
    }
  }

  // ─── Watchdog ───────────────────────────────────────────────────────────────

  private armWatchdog(lease: TransferLease) {
    this.clearWatchdog(lease);
    lease.watchdog = setTimeout(() => {
      lease.watchdog = null;
      if (lease.state !== 'ACTIVE') return;
      this.logTransfer(lease.clientId, lease.transferId, `WATCHDOG_TIMEOUT(${this.transferWatchdogMs}ms)`);
      // Tell the customer so its sender stops waiting instead of hanging.
      try {
        lease.notifyCancel('Shop transfer watchdog timeout — no data received.');
      } catch {}
      this.events.onError?.(lease.clientId, 'Transfer stalled and was cancelled by the shop.');
      this.finalizeTransfer(lease.transferId, 'SHOP_VERIFICATION_TIMEOUT');
    }, this.transferWatchdogMs);
  }

  private clearWatchdog(lease: TransferLease) {
    if (lease.watchdog !== null) {
      clearTimeout(lease.watchdog);
      lease.watchdog = null;
    }
  }

  /** Re-arm the inactivity watchdog — called on every progress tick. */
  private touchLease(transferId: string) {
    const lease = this.leases.get(transferId);
    if (lease && lease.state === 'ACTIVE') {
      this.armWatchdog(lease);
    }
  }

  /** Finalize every non-terminal lease owned by a customer. */
  private finalizeLeasesForClient(clientId: string, reason: TransferTerminalReason) {
    const owned: string[] = [];
    for (const lease of this.leases.values()) {
      if (lease.clientId === clientId && lease.state !== 'FINALIZED') {
        owned.push(lease.transferId);
      }
    }
    for (const transferId of owned) {
      this.releaseLease(transferId, reason);
    }
    if (owned.length > 0) this.tryDequeue();
  }

  /** Drop finalized leases for a customer so the map cannot grow unbounded. */
  private pruneFinalizedLeases(clientId: string) {
    for (const [transferId, lease] of this.leases.entries()) {
      if (lease.clientId === clientId && lease.state === 'FINALIZED') {
        this.leases.delete(transferId);
      }
    }
    this.queueOrder = this.queueOrder.filter((id) => this.leases.has(id));
  }

  // ─── Customer lifecycle ─────────────────────────────────────────────────────

  private handleCustomerJoined(peerId: string, customerData: { clientId: string; customerCode: string; displayName?: string | null; batchId: string }) {
    const clientId = customerData.clientId;
    const existing = this.customers.get(clientId);

    if (existing) {
      // Reconnect: the old transport is dead, so any transfer still riding it is
      // terminal. Release those slots before we build the replacement peer.
      // NOTE: `existing.documents` and `existing.transfers` are deliberately left
      // untouched. A reconnect replaces the customer's TRANSPORT, never their
      // history — losing documents here is precisely the attribution bug that real
      // devices exposed.
      existing.connectionState = 'DISCONNECTED';
      this.finalizeLeasesForClient(clientId, 'PEER_DISCONNECTED');
      this.pruneFinalizedLeases(clientId);
      if (existing.receiver) {
        existing.receiver.cleanup();
        existing.receiver = null;
      }
      existing.peer.close();
    }

    const peer = this.peerFactory({
      role: 'shop',
      signalingClient: this.signaling,
      iceServers: this.iceServers,
      targetPeerId: peerId,
      onConnectionStateChange: (state) => {
        const c = this.customers.get(clientId);
        // The peerId guard is what keeps a superseded peer's late callbacks from
        // mutating the customer that replaced it.
        if (c && c.peerId === peerId) {
          this.logWebrtc(clientId, peerId, state);
          c.connectionState = state === 'connected' ? 'CONNECTED' : state === 'failed' || state === 'disconnected' || state === 'closed' ? 'DISCONNECTED' : 'CONNECTING';
          this.events.onConnectionStateChange?.(clientId, c.connectionState);
          if (state === 'failed' || state === 'closed') {
            // The underlying connection is unusable — nothing can complete on it.
            this.finalizeLeasesForClient(clientId, 'WEBRTC_FAILED');
          }
        }
      },
      onDataChannelReady: (channel) => {
        const c = this.customers.get(clientId);
        if (c && c.peerId === peerId) {
          c.receiver = new FileReceiver(channel, {
            onProgress: (progress) => {
              c.transfers.set(progress.transferId, progress);
              // Any forward progress proves the peer is alive.
              this.touchLease(progress.transferId);
              this.events.onTransferProgress?.(clientId, progress);
            },
            onFileOffer: (offer, accept, wait) => {
              const notifyCancel = (reason: string) => {
                if (channel.readyState === 'open') {
                  const cancelMsg: DataChannelControlMessage = {
                    type: 'TRANSFER_CANCEL',
                    transferId: offer.transferId,
                    reason: reason.slice(0, 200),
                  };
                  channel.send(JSON.stringify(cancelMsg));
                }
              };

              this.requestTransferSlot(clientId, offer.transferId, accept, notifyCancel);

              // If it could not start immediately, tell the customer to hold.
              if (this.leases.get(offer.transferId)?.state === 'QUEUED') {
                wait();
              }
            },
            onFileReceived: (doc) => {
              // Attribution is stamped HERE, at the only layer that knows both the
              // document and the customer, and stored on the customer itself. The
              // dashboard never has to work out who a document belongs to.
              const shopDoc: ShopDocument = {
                ...doc,
                clientId,
                batchId: c.batchId,
                customerCode: c.customerCode,
                displayName: c.displayName,
              };
              c.documents.set(shopDoc.documentId, shopDoc);
              this.finalizeTransfer(doc.transferId, 'COMPLETED');
              this.refreshBatchStatus(c);
              this.events.onFileReceived?.(clientId, shopDoc);
            },
            onError: (transferId, error) => {
              // One choke point for every receiver-side failure: missing chunks,
              // checksum mismatch, sender cancel, assembly error.
              this.finalizeTransfer(transferId, 'FAILED');
              this.events.onError?.(clientId, error);
            },
          });
        }
      },
      onDataChannelClosed: () => {
        const c = this.customers.get(clientId);
        if (c && c.peerId === peerId) {
          // The channel is gone: no ACK or chunk can ever arrive again.
          this.finalizeLeasesForClient(clientId, 'DATA_CHANNEL_CLOSED');
          if (c.receiver) {
            c.receiver.cleanup();
            c.receiver = null;
          }
        }
      },
      onError: (err) => {
        this.events.onError?.(clientId, err.message || 'WebRTC Error');
      }
    });

    if (existing) {
      // Rebind the transport onto the SAME CustomerSession object. Identity,
      // documents and transfer history all survive; only peerId/peer change.
      existing.peerId = peerId;
      existing.peer = peer;
      existing.connectionState = 'CONNECTING';
      existing.customerCode = customerData.customerCode;
      existing.batchId = customerData.batchId;
      if (customerData.displayName !== undefined) {
         existing.displayName = customerData.displayName;
      }
      this.refreshBatchStatus(existing);
      this.logCustomer(existing, 'RECONNECTED');
      this.events.onCustomerUpdated?.(existing);
    } else {
      const session: CustomerSession = {
        clientId,
        peerId,
        customerCode: customerData.customerCode,
        batchId: customerData.batchId,
        batchStatus: 'EMPTY',
        displayName: customerData.displayName || null,
        connectionState: 'CONNECTING',
        peer,
        receiver: null,
        transfers: new Map(),
        documents: new Map(),
      };
      this.customers.set(clientId, session);
      this.logCustomer(session, 'JOINED');
      this.events.onCustomerJoined?.(session);
    }

    peer.startOffer(peerId);
  }

  private handleCustomerLeftByPeerId(peerId: string, clientId?: string) {
    let targetClientId = clientId;
    if (!targetClientId) {
       for (const [cid, cust] of this.customers.entries()) {
           if (cust.peerId === peerId) {
               targetClientId = cid;
               break;
           }
       }
    }
    if (targetClientId) {
       this.handleCustomerLeft(targetClientId);
    }
  }

  private handleCustomerLeft(clientId: string) {
    const cust = this.customers.get(clientId);
    if (cust) {
      // Order matters: mark DISCONNECTED first so the dequeue pass below cannot
      // promote one of this customer's own queued files onto a dead channel.
      cust.connectionState = 'DISCONNECTED';

      // Release every slot this customer held or was waiting on. This replaces the
      // old "count RECEIVING/VERIFYING progress entries and subtract" heuristic,
      // which could both over- and under-release the global counter.
      this.finalizeLeasesForClient(clientId, 'PEER_DISCONNECTED');

      if (cust.receiver) {
        cust.receiver.cleanup();
        cust.receiver = null;
      }
      cust.peer.close();

      this.logCustomer(cust, 'DISCONNECTED');
      this.refreshBatchStatus(cust);
      this.events.onConnectionStateChange?.(clientId, 'DISCONNECTED');
      // The customer is NEVER deleted. clientId is the durable logical identity and
      // its documents must outlive the transport; the dashboard keeps showing the
      // card (greyed) rather than dropping the person and orphaning their files.
      this.events.onCustomerLeft?.(clientId);
    }
  }

  public getCustomers(): CustomerSession[] {
    return Array.from(this.customers.values());
  }

  public getCustomer(clientId: string): CustomerSession | undefined {
    return this.customers.get(clientId);
  }

  /** Every document the shop holds, newest first, fully attributed. */
  public getDocuments(): ShopDocument[] {
    const all: ShopDocument[] = [];
    for (const cust of this.customers.values()) {
      for (const doc of cust.documents.values()) all.push(doc);
    }
    return all.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  }

  public cleanup() {
    this.teardownSignalingListeners();
    for (const clientId of this.customers.keys()) {
      this.handleCustomerLeft(clientId);
    }
    // Belt-and-braces: no timer may outlive the manager.
    for (const lease of this.leases.values()) {
      this.clearWatchdog(lease);
    }
    this.leases.clear();
    this.queueOrder = [];
  }
}
