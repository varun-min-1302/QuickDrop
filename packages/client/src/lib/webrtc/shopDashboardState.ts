import { TransferProgress } from '@quickdrop/shared';
import { BatchStatus, CustomerSession, ShopDocument } from './ShopPeerManager.js';

/**
 * Pure state algebra for the shop dashboard.
 *
 * Every one of these functions takes the previous collection and ONE incoming fact,
 * and returns a new collection that MERGES the fact in. None of them ever rebuilds a
 * collection from a single-customer event — that was the defect real devices exposed:
 * `setCustomers(prev => prev.filter(...))` on a transient drop, and a
 * `prev.map(...)` update that silently no-ops once the entry is gone, together made a
 * customer vanish permanently and orphaned every document they had already sent.
 *
 * They live outside the hook so the merge semantics can be asserted directly, without
 * a DOM or a React renderer.
 */

/**
 * The dashboard's immutable projection of a {@link CustomerSession}. The session
 * object itself is mutable and owned by ShopPeerManager; copying the fields the UI
 * needs gives React a new reference on every change and keeps the manager the single
 * source of truth.
 */
export interface ShopCustomerView {
  clientId: string;
  peerId: string;
  customerCode: string;
  displayName: string | null;
  batchId: string;
  batchStatus: BatchStatus;
  connectionState: CustomerSession['connectionState'];
}

export type TransferMap = Map<string, Map<string, TransferProgress>>;

export function toCustomerView(session: CustomerSession): ShopCustomerView {
  return {
    clientId: session.clientId,
    peerId: session.peerId,
    customerCode: session.customerCode,
    displayName: session.displayName,
    batchId: session.batchId,
    batchStatus: session.batchStatus,
    connectionState: session.connectionState,
  };
}

/**
 * Upsert one customer, keyed by the DURABLE clientId.
 *
 * - A clientId already present is updated IN PLACE, preserving its position so cards
 *   never reshuffle when someone reconnects.
 * - A clientId not present is appended.
 *
 * This is deliberately the only entry point for both "joined" and "updated": a
 * duplicate PEER_JOINED for a clientId that already exists must replace that
 * customer's transport, not create a second logical customer — and an update for a
 * customer that is (wrongly) absent must restore them rather than silently do nothing.
 */
export function mergeCustomer(
  prev: readonly ShopCustomerView[],
  incoming: ShopCustomerView,
): ShopCustomerView[] {
  const index = prev.findIndex((c) => c.clientId === incoming.clientId);
  if (index === -1) return [...prev, incoming];
  const next = prev.slice();
  next[index] = { ...next[index], ...incoming };
  return next;
}

/**
 * Apply a partial change to exactly one customer. Absent clientId → unchanged
 * collection (there is nothing to patch and nothing to invent).
 */
export function patchCustomer(
  prev: readonly ShopCustomerView[],
  clientId: string,
  patch: Partial<ShopCustomerView>,
): ShopCustomerView[] {
  const index = prev.findIndex((c) => c.clientId === clientId);
  if (index === -1) return prev.slice();
  const next = prev.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

/**
 * Append or replace ONE document, keyed by documentId, newest first.
 *
 * Never `setReceivedDocs(justThisCustomersDocs)` — a FILE_RECEIVED for B must leave
 * A's and C's documents exactly where they were.
 */
export function mergeDocument(
  prev: readonly ShopDocument[],
  incoming: ShopDocument,
): ShopDocument[] {
  const index = prev.findIndex((d) => d.documentId === incoming.documentId);
  if (index === -1) return [incoming, ...prev];
  const next = prev.slice();
  next[index] = incoming;
  return next;
}

export function removeDocument(
  prev: readonly ShopDocument[],
  documentId: string,
): ShopDocument[] {
  return prev.filter((d) => d.documentId !== documentId);
}

/** Record progress for one customer's one transfer, touching no other customer. */
export function setTransferProgress(
  prev: TransferMap,
  clientId: string,
  progress: TransferProgress,
): TransferMap {
  const next = new Map(prev);
  const forCustomer = new Map(next.get(clientId) ?? []);
  forCustomer.set(progress.transferId, progress);
  next.set(clientId, forCustomer);
  return next;
}

/** Drop one finished transfer. The customer's own map is kept (it may hold others). */
export function clearTransferProgress(
  prev: TransferMap,
  clientId: string,
  transferId: string,
): TransferMap {
  const forCustomer = prev.get(clientId);
  if (!forCustomer) return prev;
  const next = new Map(prev);
  const copy = new Map(forCustomer);
  copy.delete(transferId);
  next.set(clientId, copy);
  return next;
}

// ─── Grouping / rendering model ────────────────────────────────────────────────

export interface DashboardGroup {
  customer: ShopCustomerView;
  documents: ShopDocument[];
  transfers: TransferProgress[];
  documentCount: number;
}

/**
 * Build the durable per-customer grouping the operator sees.
 *
 * Privacy gate (spec): a customer who has merely scanned and connected but offered
 * nothing is NOT shown. Visibility begins at the first FILE_OFFER — i.e. as soon as
 * they have either a transfer in flight or a received document — and from then on
 * their group persists for the dashboard's lifetime, connected or not.
 *
 * Documents are matched to customers by clientId. Any document whose customer is
 * somehow absent is still returned in `orphans` WITH its own attribution intact, so
 * the UI can render it under the customer's own name rather than an anonymous list.
 */
export function groupDashboard(
  customers: readonly ShopCustomerView[],
  documents: readonly ShopDocument[],
  transfers: TransferMap,
): { groups: DashboardGroup[]; orphans: ShopDocument[] } {
  const known = new Set(customers.map((c) => c.clientId));
  const groups: DashboardGroup[] = [];

  for (const customer of customers) {
    const docs = documents.filter((d) => d.clientId === customer.clientId);
    const active = Array.from(transfers.get(customer.clientId)?.values() ?? []);
    if (docs.length === 0 && active.length === 0) continue; // privacy gate
    groups.push({
      customer,
      documents: docs,
      transfers: active,
      documentCount: docs.length,
    });
  }

  const orphans = documents.filter((d) => !known.has(d.clientId));
  return { groups, orphans };
}
