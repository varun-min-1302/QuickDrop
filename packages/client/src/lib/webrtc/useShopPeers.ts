import { useState, useEffect, useRef } from 'react';
import { SignalingClient } from './signalingClient.js';
import { IceServerConfig, TransferProgress } from '@quickdrop/shared';
import { ReceivedDocument } from '../transfer/receiver.js';
import { ShopPeerManager, CustomerSession } from './ShopPeerManager.js';

export interface ShopReceivedDocument extends ReceivedDocument {
  clientId: string;
  customerCode: string;
}

export function useShopPeers(signaling: SignalingClient | null, iceServers: IceServerConfig[]) {
  const [customers, setCustomers] = useState<CustomerSession[]>([]);
  const [transfers, setTransfers] = useState<Map<string, Map<string, TransferProgress>>>(new Map());
  const [receivedDocs, setReceivedDocs] = useState<ShopReceivedDocument[]>([]);

  const managerRef = useRef<ShopPeerManager | null>(null);
  const iceServersRef = useRef<IceServerConfig[]>(iceServers);

  useEffect(() => {
    if (!signaling) return;

    const manager = new ShopPeerManager(signaling, iceServersRef.current, {
      onCustomerJoined: (customer) => {
        setCustomers((prev) => [...prev, customer]);
      },
      onCustomerUpdated: (customer) => {
        setCustomers((prev) => prev.map(c => c.clientId === customer.clientId ? customer : c));
      },
      onCustomerLeft: (clientId) => {
        setCustomers((prev) => prev.filter(c => c.clientId !== clientId));
        setTransfers((prev) => {
          const next = new Map(prev);
          next.delete(clientId);
          return next;
        });
      },
      onConnectionStateChange: (clientId, state) => {
        setCustomers((prev) => prev.map(c => c.clientId === clientId ? { ...c, connectionState: state } : c));
      },
      onTransferProgress: (clientId, progress) => {
        setTransfers((prev) => {
          const next = new Map(prev);
          const peerTransfers = new Map(next.get(clientId) || new Map());
          peerTransfers.set(progress.transferId, progress);
          next.set(clientId, peerTransfers);
          return next;
        });
      },
      onFileReceived: (clientId, doc) => {
        setReceivedDocs((prev) => {
          const c = customers.find(x => x.clientId === clientId) || managerRef.current?.getCustomers().find(x => x.clientId === clientId);
          return [{ ...doc, clientId, customerCode: c?.customerCode || 'Unknown' }, ...prev];
        });
        setTransfers((prev) => {
          const next = new Map(prev);
          const peerTransfers = new Map(next.get(clientId) || new Map());
          peerTransfers.delete(doc.transferId);
          next.set(clientId, peerTransfers);
          return next;
        });
        
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
        } catch {}
      },
      onError: (clientId, error) => {
        console.error(`Error for peer ${clientId}:`, error);
      }
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
    manager: managerRef.current
  };
}
