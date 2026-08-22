import { IceServerConfig, TransferProgress, DataChannelControlMessage } from '@quickdrop/shared';
import { SignalingClient, SignalingEventMap } from './signalingClient.js';
import { WebRTCPeer } from './peerConnection.js';
import { FileReceiver, ReceivedDocument } from '../transfer/receiver.js';

export interface CustomerSession {
  clientId: string;
  peerId: string;
  customerCode: string;
  batchId: string;
  displayName: string | null;
  connectionState: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';
  peer: WebRTCPeer;
  receiver: FileReceiver | null;
  transfers: Map<string, TransferProgress>;
}

export interface ShopPeerManagerEvents {
  onCustomerJoined?: (customer: CustomerSession) => void;
  onCustomerUpdated?: (customer: CustomerSession) => void;
  onCustomerLeft?: (clientId: string) => void;
  onConnectionStateChange?: (clientId: string, state: CustomerSession['connectionState']) => void;
  onTransferProgress?: (clientId: string, progress: TransferProgress) => void;
  onFileReceived?: (clientId: string, doc: ReceivedDocument) => void;
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
  /** Sends FILE_ACCEPT to the customer. */
  accept: () => void;
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

// ─── Dev-only queue logging (Requirement 15) ───────────────────────────────────

let QUEUE_LOG_ENABLED = (() => {
  try {
    return Boolean((import.meta as any).env?.DEV);
  } catch {
    return false;
  }
})();

/** Silence or enable the [QUEUE]/[TRANSFER] trace logs (tests turn this off). */
export function setTransferQueueLogging(enabled: boolean) {
  QUEUE_LOG_ENABLED = enabled;
}

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
    if (QUEUE_LOG_ENABLED) console.log(msg);
  }

  // ─── Signaling listeners ────────────────────────────────────────────────────
  // Stored handler references so the exact same functions can be removed in
  // cleanup(). Previously these were inline arrows registered but never removed —
  // every manager rebuild (e.g. a React effect re-run when iceServers arrived, or
  // StrictMode's double-invoke) stacked another listener set, so a single
  // customer join fired handleCustomerJoined N times and the shop sent N OFFERs.

  private onPeerJoined = (data: Parameters<SignalingEventMap['peer_joined']>[0]) => {
    if (data.role === 'customer' && data.customer) {
      this.handleCustomerJoined(data.peerId, data.customer);
    }
  };

  private onPeerLeft = (data: Parameters<SignalingEventMap['peer_left']>[0]) => {
    if (data.role === 'customer') {
      this.handleCustomerLeftByPeerId(data.peerId, data.clientId);
    }
  };

  private onCustomerUpdatedEvent = (data: Parameters<SignalingEventMap['customer_updated']>[0]) => {
    const cust = this.customers.get(data.clientId || "");
    if (cust) {
      cust.displayName = data.displayName;
      this.events.onCustomerUpdated?.(cust);
    }
  };

  private setupSignalingListeners() {
    this.signaling.on('peer_joined', this.onPeerJoined);
    this.signaling.on('peer_left', this.onPeerLeft);
    this.signaling.on('customer_updated', this.onCustomerUpdatedEvent);
  }

  private teardownSignalingListeners() {
    this.signaling.off('peer_joined', this.onPeerJoined);
    this.signaling.off('peer_left', this.onPeerLeft);
    this.signaling.off('customer_updated', this.onCustomerUpdatedEvent);
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
    accept: () => void,
    notifyCancel: (reason: string) => void,
  ) {
    const existing = this.leases.get(transferId);
    if (existing) {
      // Duplicate FILE_OFFER for a transferId we already track — never allow a
      // second lease for the same id (that would let one file take two slots).
      this.log(`[QUEUE] duplicate offer ignored transfer=${shortId(transferId)} state=${existing.state}`);
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
    this.log(`[QUEUE] enqueue transfer=${shortId(transferId)} client=${shortId(clientId)} depth=${this.getQueuedTransferIds().length}`);

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
      this.log(`[QUEUE] finalize ignored (unknown) transfer=${shortId(transferId)} reason=${reason}`);
      return false;
    }
    if (lease.state === 'FINALIZED') {
      this.log(`[QUEUE] finalize ignored (already final) transfer=${shortId(transferId)} reason=${reason}`);
      return false;
    }

    const wasActive = lease.state === 'ACTIVE';
    lease.state = 'FINALIZED';
    this.clearWatchdog(lease);

    this.log(
      `[TRANSFER] finalize transfer=${shortId(transferId)} client=${shortId(lease.clientId)} reason=${reason} wasActive=${wasActive}`,
    );
    if (wasActive) {
      this.log(`[QUEUE] release transfer=${shortId(transferId)} active=${this.getActiveTransferCount()}`);
    }
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
        this.log(`[QUEUE] skip transfer=${shortId(transferId)} reason=customer_gone`);
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
    this.log(
      `[QUEUE] acquire transfer=${shortId(lease.transferId)} client=${shortId(lease.clientId)} active=${this.getActiveTransferCount()}`,
    );
    this.log(`[QUEUE] accept transfer=${shortId(lease.transferId)}`);
    try {
      lease.accept();
    } catch (err) {
      // If we cannot even send FILE_ACCEPT the slot must not stay held.
      this.log(`[QUEUE] accept failed transfer=${shortId(lease.transferId)}`);
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
      this.log(`[TRANSFER] timeout transfer=${shortId(lease.transferId)} (no activity for ${this.transferWatchdogMs}ms)`);
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
        if (c && c.peerId === peerId) {
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
              this.finalizeTransfer(doc.transferId, 'COMPLETED');
              this.events.onFileReceived?.(clientId, doc);
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
      existing.peerId = peerId;
      existing.peer = peer;
      existing.connectionState = 'CONNECTING';
      existing.customerCode = customerData.customerCode;
      existing.batchId = customerData.batchId;
      if (customerData.displayName !== undefined) {
         existing.displayName = customerData.displayName;
      }
      this.events.onCustomerUpdated?.(existing);
    } else {
      const session: CustomerSession = {
        clientId,
        peerId,
        customerCode: customerData.customerCode,
        batchId: customerData.batchId,
        displayName: customerData.displayName || null,
        connectionState: 'CONNECTING',
        peer,
        receiver: null,
        transfers: new Map(),
      };
      this.customers.set(clientId, session);
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

      this.events.onConnectionStateChange?.(clientId, 'DISCONNECTED');
      // We no longer delete the customer, so they stay in history if they have docs.
      this.events.onCustomerLeft?.(clientId);
    }
  }

  public getCustomers(): CustomerSession[] {
    return Array.from(this.customers.values());
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
