/**
 * Regression suite for the shop dashboard's state algebra.
 *
 * Real-device bug 2: with three phones, customer A's already-received document lost its
 * customer association, C's documents sometimes appeared with no name, and the customer
 * list looked like it was being rebuilt from scratch. The cause was not in the transfer
 * engine — it was that single-customer events were being applied as whole-collection
 * REPLACEMENTS:
 *
 *   • `setCustomers(prev => prev.filter(c => c.clientId !== gone))` on a transient
 *     PEER_LEFT, while ShopPeerManager deliberately KEEPS the customer. The rejoin then
 *     took the "already known" branch and emitted only onCustomerUpdated, whose
 *     `prev.map(...)` is a silent no-op on a collection the customer is no longer in —
 *     so they never came back and every document they had sent was orphaned.
 *   • a stale-closure `customers.find(...)` that resolved a document's owner to
 *     `'Unknown'`.
 *
 * Every function under test therefore takes the previous collection plus ONE fact and
 * merges. These tests assert that merge semantics directly, and — using `toBe` identity
 * checks — that untouched entries are not even re-created, which is the strongest
 * available statement of "customer B's event did not disturb A".
 *
 * Covers scenarios 9, 10, 11, 12, 20, 21, 22, 23, 25 of the regression matrix.
 */
import { describe, it, expect } from 'vitest';
import { TransferProgress } from '@quickdrop/shared';
import {
  ShopCustomerView,
  TransferMap,
  clearTransferProgress,
  groupDashboard,
  mergeCustomer,
  mergeDocument,
  patchCustomer,
  removeDocument,
  setTransferProgress,
} from '../lib/webrtc/shopDashboardState.js';
import { ShopDocument } from '../lib/webrtc/ShopPeerManager.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function customer(clientId: string, overrides: Partial<ShopCustomerView> = {}): ShopCustomerView {
  return {
    clientId,
    peerId: `peer-${clientId}`,
    customerCode: clientId.toUpperCase(),
    displayName: null,
    batchId: `batch-${clientId}`,
    batchStatus: 'EMPTY',
    connectionState: 'CONNECTED',
    ...overrides,
  };
}

let docSeq = 0;

function document(clientId: string, overrides: Partial<ShopDocument> = {}): ShopDocument {
  const transferId = overrides.transferId ?? `tr-${clientId}-${++docSeq}`;
  return {
    documentId: `doc_${transferId}`,
    transferId,
    name: `${clientId}-file.pdf`,
    size: 1024,
    mime: 'application/pdf',
    sha256: 'a'.repeat(64),
    file: new File([new Uint8Array(4)], `${clientId}-file.pdf`, { type: 'application/pdf' }),
    objectUrl: `blob:mock/${transferId}`,
    receivedAt: new Date(1_700_000_000_000 + docSeq * 1000),
    status: 'RECEIVED',
    clientId,
    batchId: `batch-${clientId}`,
    customerCode: clientId.toUpperCase(),
    displayName: null,
    ...overrides,
  };
}

function progress(transferId: string, overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    transferId,
    fileName: 'in-flight.pdf',
    fileSize: 2048,
    transferredBytes: 1024,
    percentage: 50,
    speedBytesPerSec: 0,
    estimatedRemainingSec: 0,
    status: 'RECEIVING',
    ...overrides,
  };
}

// ─── Customer collection ──────────────────────────────────────────────────────

describe('dashboard customers — merge, never replace (scenario 22)', () => {
  it('appends a customer the dashboard has not seen', () => {
    const next = mergeCustomer([], customer('a'));
    expect(next.map((c) => c.clientId)).toEqual(['a']);
  });

  it('adding B leaves A untouched, by reference', () => {
    const a = customer('a');
    const withA = mergeCustomer([], a);
    const withB = mergeCustomer(withA, customer('b'));

    expect(withB.map((c) => c.clientId)).toEqual(['a', 'b']);
    expect(withB[0]).toBe(a); // not re-created, not re-ordered
  });

  it('adding C removes neither B nor A (scenario 10)', () => {
    let list: ShopCustomerView[] = [];
    for (const id of ['a', 'b', 'c']) list = mergeCustomer(list, customer(id));
    expect(list.map((c) => c.clientId)).toEqual(['a', 'b', 'c']);
  });

  it('updates an existing clientId in place, holding its position (no card reshuffle)', () => {
    let list = [customer('a'), customer('b'), customer('c')];
    list = mergeCustomer(list, customer('b', { displayName: 'Rahul' }));

    expect(list.map((c) => c.clientId)).toEqual(['a', 'b', 'c']);
    expect(list[1].displayName).toBe('Rahul');
  });

  it('a duplicate PEER_JOINED for the same clientId replaces the transport, not the person (scenario 20)', () => {
    let list = mergeCustomer([], customer('a', { peerId: 'peer-1' }));
    list = mergeCustomer(list, customer('a', { peerId: 'peer-2', connectionState: 'CONNECTING' }));

    expect(list).toHaveLength(1); // exactly one logical customer
    expect(list[0].clientId).toBe('a');
    expect(list[0].peerId).toBe('peer-2');
  });

  it('an update for a customer that has (wrongly) gone missing restores them rather than doing nothing', () => {
    // This is the exact shape of the bug: the collection lost the customer, and the
    // follow-up event must not be a silent no-op.
    const list = mergeCustomer([], customer('a', { displayName: 'Rahul' }));
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('Rahul');
  });

  it('patchCustomer changes exactly one customer and re-uses the others', () => {
    const a = customer('a');
    const b = customer('b');
    const c = customer('c');
    const next = patchCustomer([a, b, c], 'b', { connectionState: 'DISCONNECTED' });

    expect(next[1].connectionState).toBe('DISCONNECTED');
    expect(next[0]).toBe(a);
    expect(next[2]).toBe(c);
  });

  it('patchCustomer invents nothing for an unknown clientId', () => {
    const list = [customer('a')];
    const next = patchCustomer(list, 'ghost', { connectionState: 'DISCONNECTED' });
    expect(next).toEqual(list);
    expect(next).toHaveLength(1);
  });

  it('a disconnect marks the customer DISCONNECTED and never drops them (scenario 21)', () => {
    let list = [customer('a'), customer('b')];
    list = patchCustomer(list, 'a', { connectionState: 'DISCONNECTED' });

    expect(list).toHaveLength(2);
    expect(list.find((c) => c.clientId === 'a')!.connectionState).toBe('DISCONNECTED');
    expect(list.find((c) => c.clientId === 'b')!.connectionState).toBe('CONNECTED');
  });
});

// ─── Document collection ──────────────────────────────────────────────────────

describe('dashboard documents — append/merge, never replace (scenario 23)', () => {
  it('prepends new documents so the newest is first', () => {
    const first = document('a');
    const second = document('a');
    const docs = mergeDocument(mergeDocument([], first), second);
    expect(docs.map((d) => d.documentId)).toEqual([second.documentId, first.documentId]);
  });

  it("a FILE_RECEIVED for B leaves A's and C's documents exactly where they were (scenarios 9, 10)", () => {
    const aDoc = document('a');
    const cDoc = document('c');
    const docs = mergeDocument(mergeDocument([], aDoc), cDoc);

    const withB = mergeDocument(docs, document('b'));

    expect(withB).toHaveLength(3);
    expect(withB.find((d) => d.documentId === aDoc.documentId)).toBe(aDoc);
    expect(withB.find((d) => d.documentId === cDoc.documentId)).toBe(cDoc);
  });

  it('re-merging the same documentId replaces that row instead of duplicating it', () => {
    const doc = document('a');
    const docs = mergeDocument([], doc);
    const again = mergeDocument(docs, { ...doc, name: 'renamed.pdf' });

    expect(again).toHaveLength(1);
    expect(again[0].name).toBe('renamed.pdf');
  });

  it('keeps every document a single customer sends (scenario 25)', () => {
    let docs: ShopDocument[] = [];
    for (let i = 0; i < 3; i++) docs = mergeDocument(docs, document('a'));

    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.clientId === 'a')).toBe(true);
    expect(new Set(docs.map((d) => d.documentId)).size).toBe(3);
  });

  it('removeDocument deletes one row by its durable documentId', () => {
    const keep = document('a');
    const drop = document('a');
    const docs = mergeDocument(mergeDocument([], keep), drop);

    const next = removeDocument(docs, drop.documentId);
    expect(next.map((d) => d.documentId)).toEqual([keep.documentId]);
  });

  it('a document carries its own attribution, so it can name its owner unaided (scenario 11)', () => {
    const doc = document('a', { customerCode: '1234', displayName: 'Rahul', batchId: 'batch-A82F' });
    expect(doc.clientId).toBe('a');
    expect(doc.customerCode).toBe('1234');
    expect(doc.displayName).toBe('Rahul');
    expect(doc.batchId).toBe('batch-A82F');
  });
});

// ─── Per-customer transfer progress ───────────────────────────────────────────

describe('dashboard transfers — scoped per customer', () => {
  it("records progress under its own customer and leaves other customers' maps alone", () => {
    let map: TransferMap = new Map();
    map = setTransferProgress(map, 'a', progress('tr-a'));
    const aMap = map.get('a')!;

    map = setTransferProgress(map, 'b', progress('tr-b'));

    expect(map.get('a')).toBe(aMap); // B's progress did not touch A
    expect(map.get('b')!.get('tr-b')!.transferId).toBe('tr-b');
  });

  it("clearing one transfer keeps the customer's other in-flight transfers", () => {
    let map: TransferMap = new Map();
    map = setTransferProgress(map, 'a', progress('tr-a1'));
    map = setTransferProgress(map, 'a', progress('tr-a2'));

    map = clearTransferProgress(map, 'a', 'tr-a1');

    expect([...map.get('a')!.keys()]).toEqual(['tr-a2']);
  });

  it('clearing an unknown customer is a no-op', () => {
    const map: TransferMap = new Map();
    expect(clearTransferProgress(map, 'ghost', 'tr-x')).toBe(map);
  });
});

// ─── Grouping ─────────────────────────────────────────────────────────────────

describe('dashboard grouping — durable per-customer sections', () => {
  it('hides a customer who has only connected, and reveals them at their first offer (privacy)', () => {
    const list = [customer('a')];

    const quiet = groupDashboard(list, [], new Map());
    expect(quiet.groups).toHaveLength(0);

    const offering = groupDashboard(list, [], setTransferProgress(new Map(), 'a', progress('tr-a')));
    expect(offering.groups).toHaveLength(1);
    expect(offering.groups[0].customer.clientId).toBe('a');
  });

  it('keeps a customer visible after they disconnect, with their documents', () => {
    const list = [customer('a', { connectionState: 'DISCONNECTED' })];
    const { groups } = groupDashboard(list, [document('a')], new Map());

    expect(groups).toHaveLength(1);
    expect(groups[0].documentCount).toBe(1);
  });

  it('groups three customers with their own documents and counts (scenarios 12, 26)', () => {
    const list = [customer('a'), customer('b'), customer('c')];
    const docs = [
      document('a'),
      document('a'),
      document('b'),
      document('c'),
      document('c'),
      document('c'),
    ];

    const { groups, orphans } = groupDashboard(list, docs, new Map());

    expect(orphans).toHaveLength(0);
    expect(groups.map((g) => [g.customer.clientId, g.documentCount])).toEqual([
      ['a', 2],
      ['b', 1],
      ['c', 3],
    ]);
    // Every grouped document really belongs to the customer it was filed under.
    for (const group of groups) {
      expect(group.documents.every((d) => d.clientId === group.customer.clientId)).toBe(true);
    }
  });

  it('a document whose customer is absent is still returned WITH its attribution', () => {
    const docs = [document('gone', { customerCode: '4321', displayName: 'Meera' })];
    const { groups, orphans } = groupDashboard([customer('a')], docs, new Map());

    expect(groups).toHaveLength(0);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].displayName).toBe('Meera');
    expect(orphans[0].customerCode).toBe('4321');
  });
});

// ─── The whole event stream ───────────────────────────────────────────────────

describe('dashboard state machine — a full three-phone session, one event at a time', () => {
  it('never loses a customer or mis-attributes a document (scenarios 9-12, 22, 23, 26)', () => {
    let customers: ShopCustomerView[] = [];
    let docs: ShopDocument[] = [];
    let transfers: TransferMap = new Map();

    const apply = {
      joined: (id: string, code: string) => {
        customers = mergeCustomer(customers, customer(id, { customerCode: code }));
      },
      offered: (id: string, transferId: string) => {
        transfers = setTransferProgress(transfers, id, progress(transferId));
      },
      received: (id: string, transferId: string) => {
        const doc = document(id, { transferId, customerCode: id.toUpperCase() });
        docs = mergeDocument(docs, doc);
        transfers = clearTransferProgress(transfers, id, transferId);
        // The hook re-projects the LIVE session (toCustomerView), so this carries
        // whatever transport the customer is currently on — it never resets peerId.
        const live = customers.find((c) => c.clientId === id)!;
        customers = mergeCustomer(customers, { ...live, batchStatus: 'READY_TO_PRINT' });
      },
      left: (id: string) => {
        customers = patchCustomer(customers, id, { connectionState: 'DISCONNECTED' });
      },
      rejoined: (id: string, peerId: string) => {
        customers = mergeCustomer(customers, customer(id, { peerId, connectionState: 'CONNECTED' }));
      },
    };

    // A connects and sends. Then B connects and sends. Then C.
    apply.joined('a', 'A');
    apply.offered('a', 'tr-a1');
    apply.received('a', 'tr-a1');

    apply.joined('b', 'B');
    apply.offered('b', 'tr-b1');
    apply.received('b', 'tr-b1');

    apply.joined('c', 'C');
    apply.offered('c', 'tr-c1');
    apply.received('c', 'tr-c1');

    // A's socket blips and the server re-notifies the shop — the classic trigger.
    apply.left('a');
    apply.rejoined('a', 'peer-a-2');
    apply.offered('a', 'tr-a2');
    apply.received('a', 'tr-a2');

    const { groups, orphans } = groupDashboard(customers, docs, transfers);

    expect(customers).toHaveLength(3); // no duplicate A, no vanished B or C
    expect(orphans).toHaveLength(0); // every document found its owner
    expect(groups.map((g) => [g.customer.clientId, g.documentCount])).toEqual([
      ['a', 2],
      ['b', 1],
      ['c', 1],
    ]);
    expect(groups[0].customer.peerId).toBe('peer-a-2'); // transport updated…
    expect(groups[0].customer.customerCode).toBe('A'); // …identity preserved
    for (const group of groups) {
      expect(group.documents.every((d) => d.customerCode === group.customer.customerCode)).toBe(true);
    }
  });
});
