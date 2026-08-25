import { useState, useEffect, useRef } from 'react';
import { SignalingClient } from './signalingClient.js';
import { IceServerConfig } from '@quickdrop/shared';
import { ShopPeerManager, ShopDocument } from './ShopPeerManager.js';
import {
  ShopCustomerView,
  TransferMap,
  clearTransferProgress,
  mergeCustomer,
  mergeDocument,
  patchCustomer,
  setTransferProgress,
  toCustomerView,
} from './shopDashboardState.js';

/**
 * @deprecated Kept as an alias so existing imports keep compiling. Attribution now
 * lives on {@link ShopDocument}, stamped by ShopPeerManager at the moment of receipt.
 */
export type ShopReceivedDocument = ShopDocument;

export function useShopPeers(signaling: SignalingClient | null, iceServers: IceServerConfig[]) {
  const [customers, setCustomers] = useState<ShopCustomerView[]>([]);
  const [transfers, setTransfers] = useState<TransferMap>(new Map());
  const [receivedDocs, setReceivedDocs] = useState<ShopDocument[]>([]);

  const managerRef = useRef<ShopPeerManager | null>(null);
  const iceServersRef = useRef<IceServerConfig[]>(iceServers);

  useEffect(() => {
    if (!signaling) return;

    // Every handler below merges ONE customer's fact into the collection. None of
    // them reads component state (there is no dependency on `customers` here, so
    // there is no stale closure to read), and none rebuilds the collection from a
    // single event.
    const manager = new ShopPeerManager(signaling, iceServersRef.current, {
      onCustomerJoined: (customer) => {
        setCustomers((prev) => mergeCustomer(prev, toCustomerView(customer)));
      },
      onCustomerUpdated: (customer) => {
        // Upsert, not map: an update for a customer missing from the projection
        // must restore them. A `prev.map(...)` here silently did nothing, which is
        // how a reconnecting customer became permanently invisible.
        setCustomers((prev) => mergeCustomer(prev, toCustomerView(customer)));
      },
      onCustomerLeft: (clientId) => {
        // Mark disconnected — never remove. clientId is the durable identity and the
        // manager still holds this customer's documents; dropping the card here is
        // what orphaned them. Their transfer map is kept for the same reason.
        setCustomers((prev) => patchCustomer(prev, clientId, { connectionState: 'DISCONNECTED' }));
      },
      onConnectionStateChange: (clientId, state) => {
        setCustomers((prev) => patchCustomer(prev, clientId, { connectionState: state }));
      },
      onTransferProgress: (clientId, progress) => {
        setTransfers((prev) => setTransferProgress(prev, clientId, progress));
      },
      onFileReceived: (clientId, doc) => {
        // `doc` already carries clientId, batchId, customerCode and displayName —
        // stamped by the manager, which is the only layer that knows both sides.
        // Nothing here has to look the customer up, so nothing here can guess wrong.
        setReceivedDocs((prev) => mergeDocument(prev, doc));
        setTransfers((prev) => clearTransferProgress(prev, clientId, doc.transferId));
        // Keep the customer's batchStatus/identity projection fresh alongside the doc.
        const session = managerRef.current?.getCustomer(clientId);
        if (session) setCustomers((prev) => mergeCustomer(prev, toCustomerView(session)));

        playReceivedChime();
      },
      onError: (clientId, error) => {
        console.error(`Error for peer ${clientId}:`, error);
      },
    });

    managerRef.current = manager;

    return () => {
      manager.cleanup();
      managerRef.current = null;
    };
  }, [signaling]);

  // Apply ICE-server updates in place. Rebuilding the manager here (the old
  // behavior, caused by listing `iceServers` as an effect dependency) tore down
  // every live customer peer AND — because listeners weren't removed on cleanup —
  // stacked a second signaling-listener set, which made the shop send two OFFERs
  // per customer. join_accepted delivers iceServers shortly after `signaling` is
  // set, before any customer joins, so applying them in place is sufficient.
  useEffect(() => {
    iceServersRef.current = iceServers;
    managerRef.current?.setIceServers(iceServers);
  }, [iceServers]);

  return {
    customers,
    transfers,
    receivedDocs,
    setReceivedDocs,
    manager: managerRef.current,
  };
}

function playReceivedChime() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880.0, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    /* audio is a nicety; never let it break receipt handling */
  }
}
