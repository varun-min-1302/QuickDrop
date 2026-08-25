/**
 * Regression suite for concurrent multi-customer transfers (real-device bugs 1, 2, 4).
 *
 * Observed on real phones, invisible to every existing test because they all drive a
 * SINGLE customer: with a shop laptop open and customers A and B pressing Send at almost
 * the same moment, A would succeed while B sometimes caused the customer page to restart,
 * and B could not reliably get into the queue. With three phones, A's already-received
 * document lost its customer, and the dashboard looked like it was rebuilding its list.
 *
 * The rule these tests exist to pin down: **customer connections run in parallel; only
 * TRANSFERS serialise.** The shop keeps one global active-transfer slot, but each
 * customer has an isolated WebRTCPeer, FileReceiver, identity and batch — so one
 * customer's failure, disconnect or stall may never reset, cancel or hide another's.
 *
 * These drive the REAL ShopPeerManager queue and REAL FileReceiver over controllable
 * mock DataChannels, one per customer. Scenario numbers refer to the regression matrix;
 * 1-12, 18-21 and 24-26 are covered here (13-17 live in customerBatchRefresh.test.ts,
 * 22-23 in shopDashboardState.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setTransferQueueLogging } from '../lib/webrtc/ShopPeerManager.js';
import { setTransferTimingsEnabled } from '../lib/transfer/timings.js';
import {
  ZERO_SHA,
  completeFile,
  createShop,
  finishFile,
  flush,
  offerFile,
  offerRealFile,
  sendCancel,
  sendFileEnd,
} from './support/multiCustomerHarness.js';

beforeEach(() => {
  if (!globalThis.crypto) {
    globalThis.crypto = require('node:crypto').webcrypto as any;
  }
  setTransferQueueLogging(false);
  setTransferTimingsEnabled(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const id = () => crypto.randomUUID();

// ─── Parallel connections ─────────────────────────────────────────────────────

describe('customers connect in parallel (scenarios 1, 3, 24)', () => {
  it('1. A and B connect concurrently and get their own peer, receiver and identity', () => {
    const { manager, joinCustomer } = createShop();

    // Both JOIN before either DataChannel opens — the real concurrent case.
    const a = joinCustomer('a', { defer: true });
    const b = joinCustomer('b', { defer: true });
    a.connect();
    b.connect();

    const customers = manager.getCustomers();
    expect(customers).toHaveLength(2);
    expect(customers.map((c) => c.clientId).sort()).toEqual(['a', 'b']);
    expect(a.peer).not.toBe(b.peer);
    expect(a.peerId).not.toBe(b.peerId);

    for (const c of customers) {
      expect(c.connectionState).toBe('CONNECTED');
      expect(c.receiver).not.toBeNull(); // an isolated FileReceiver each
    }
    expect(manager.getCustomer('a')!.receiver).not.toBe(manager.getCustomer('b')!.receiver);
  });

  it('3. A, B and C all handshake simultaneously — none starves the others', () => {
    const { manager, joinCustomer, peerLog } = createShop();

    const trio = ['a', 'b', 'c'].map((cid) => joinCustomer(cid, { defer: true }));
    // All three are mid-handshake at once…
    expect(manager.getCustomers().every((c) => c.connectionState === 'CONNECTING')).toBe(true);
    expect(peerLog).toHaveLength(3);
    for (const c of trio) expect(c.peer.startOffer).toHaveBeenCalledWith(c.peerId);

    // …then they come up in an arbitrary order.
    trio[2].connect();
    trio[0].connect();
    trio[1].connect();

    expect(manager.getCustomers()).toHaveLength(3);
    expect(manager.getCustomers().every((c) => c.connectionState === 'CONNECTED')).toBe(true);
  });

  it('24. three phones on the SAME permanent QR are three distinct customers', () => {
    const { manager, joinCustomer } = createShop();

    joinCustomer('a', { customerCode: '1234', batchId: 'batch-A82F', displayName: 'Rahul' });
    joinCustomer('b', { customerCode: '5678', batchId: 'batch-B19C', displayName: 'Meera' });
    joinCustomer('c', { customerCode: '9012', batchId: 'batch-C55D', displayName: null });

    const customers = manager.getCustomers();
    expect(customers).toHaveLength(3);
    expect(new Set(customers.map((c) => c.customerCode)).size).toBe(3);
    expect(new Set(customers.map((c) => c.batchId)).size).toBe(3);
    expect(manager.getCustomer('a')!.displayName).toBe('Rahul');
    expect(manager.getCustomer('c')!.displayName).toBeNull();
  });
});

// ─── The single active slot ───────────────────────────────────────────────────

describe('concurrent Send: transfers serialise, customers do not (scenarios 2, 4, 8)', () => {
  it('2. A and B press Send together → A ACTIVE, B QUEUED and told to wait', async () => {
    const { manager, joinCustomer } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const idA = id();
    const idB = id();

    offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    expect(manager.getLeaseState(idA)).toBe('ACTIVE');
    expect(manager.getLeaseState(idB)).toBe('QUEUED');
    expect(manager.getActiveTransferCount()).toBe(1);

    // A was accepted; B was told to hold — not rejected, not cancelled.
    expect(a.channel.acceptedIds()).toEqual([idA]);
    expect(b.channel.acceptedIds()).toEqual([]);
    expect(b.channel.waitingIds()).toEqual([idB]);
    expect(b.channel.cancelledIds()).toEqual([]);
  });

  it("8. B's session stays fully connected the whole time it waits — no reset, no teardown", async () => {
    const { manager, joinCustomer, events } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const idA = id();
    const idB = id();

    offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    const bSession = manager.getCustomer('b')!;
    expect(bSession.connectionState).toBe('CONNECTED');
    expect(bSession.batchStatus).toBe('RECEIVING'); // queued work counts as in-flight
    expect(b.peer.close).not.toHaveBeenCalled();
    expect(b.channel.readyState).toBe('open');
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onCustomerLeft).not.toHaveBeenCalled();
  });

  it('4. A, B and C press Send together → exactly one active, the rest queued FIFO', async () => {
    const { manager, joinCustomer } = createShop();
    const [a, b, c] = ['a', 'b', 'c'].map((cid) => joinCustomer(cid));
    const idA = id();
    const idB = id();
    const idC = id();

    offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(c.channel, idC, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    expect(manager.getActiveTransferCount()).toBe(1);
    expect(manager.getQueuedTransferIds()).toEqual([idB, idC]);

    // Drain in order, and confirm each promotion reaches the right customer's channel.
    sendCancel(a.channel, idA);
    await flush(1);
    expect(manager.getLeaseState(idB)).toBe('ACTIVE');
    expect(b.channel.acceptedIds()).toEqual([idB]);
    expect(c.channel.acceptedIds()).toEqual([]);

    sendCancel(b.channel, idB);
    await flush(1);
    expect(manager.getLeaseState(idC)).toBe('ACTIVE');
    expect(c.channel.acceptedIds()).toEqual([idC]);

    sendCancel(c.channel, idC);
    await flush(1);
    expect(manager.getActiveTransferCount()).toBe(0);
    expect(manager.getQueuedTransferIds()).toEqual([]);
  });
});

// ─── Queue advancement across customers ──────────────────────────────────────

describe("one customer's outcome always advances the next (scenarios 5, 6, 7, 18, 19)", () => {
  it("5. A completes → B's transfer starts automatically", async () => {
    const { manager, joinCustomer, events } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const idA = id();
    const idB = id();

    const bytesA = await offerRealFile(a.channel, idA, { name: 'a-resume.pdf' });
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);
    expect(manager.getLeaseState(idB)).toBe('QUEUED');

    await finishFile(a.channel, idA, bytesA);

    expect(manager.getLeaseState(idA)).toBe('FINALIZED');
    expect(manager.getLeaseState(idB)).toBe('ACTIVE');
    expect(b.channel.acceptedIds()).toEqual([idB]);
    expect(events.onFileReceived).toHaveBeenCalledTimes(1);
    expect(events.onFileReceived.mock.calls[0][0]).toBe('a');
  });

  it("6. A FAILS → B's transfer starts through the very same path", async () => {
    const { manager, joinCustomer, events } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const idA = id();
    const idB = id();

    // A promises two chunks and delivers none.
    offerFile(a.channel, idA, { size: 2048, totalChunks: 2, sha256: ZERO_SHA });
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);
    sendFileEnd(a.channel, idA);
    await flush(2);

    expect(manager.getLeaseState(idA)).toBe('FINALIZED');
    expect(manager.getLeaseState(idB)).toBe('ACTIVE');
    expect(b.channel.acceptedIds()).toEqual([idB]);
    // A's failure is reported against A only.
    expect(events.onError).toHaveBeenCalled();
    expect(events.onError.mock.calls.every((call) => call[0] === 'a')).toBe(true);
  });

  it("7. A DISCONNECTS mid-transfer → B's transfer starts, A's card survives", async () => {
    const { manager, joinCustomer, leave, events } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const idA = id();
    const idB = id();

    offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    leave('a', a.peerId);
    await flush(2);

    expect(manager.getLeaseState(idB)).toBe('ACTIVE');
    expect(b.channel.acceptedIds()).toEqual([idB]);
    // A is marked gone but never deleted — clientId is the durable identity.
    expect(manager.getCustomer('a')).toBeDefined();
    expect(manager.getCustomer('a')!.connectionState).toBe('DISCONNECTED');
    expect(events.onCustomerLeft).toHaveBeenCalledWith('a');
    expect(manager.getCustomers()).toHaveLength(2);
  });

  it('18. no deadlock after a failure: the slot returns to zero and the queue empties', async () => {
    const { manager, joinCustomer } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const idA = id();
    const idB = id();

    offerFile(a.channel, idA, { size: 4096, totalChunks: 4, sha256: ZERO_SHA });
    offerFile(b.channel, idB, { size: 4096, totalChunks: 4, sha256: ZERO_SHA });
    await flush(1);

    sendFileEnd(a.channel, idA); // fails: 0/4 chunks
    await flush(2);
    sendFileEnd(b.channel, idB); // fails too
    await flush(2);

    expect(manager.getActiveTransferCount()).toBe(0);
    expect(manager.getQueuedTransferIds()).toEqual([]);

    // And the shop is still usable: a fresh offer takes the slot immediately.
    const idC = id();
    offerFile(a.channel, idC, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);
    expect(manager.getLeaseState(idC)).toBe('ACTIVE');
  });

  it('19. no deadlock after a disconnect: a queued file of a departed customer is skipped, not blocking', async () => {
    const { manager, joinCustomer, leave } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const c = joinCustomer('c');
    const idA = id();
    const idB = id();
    const idC = id();

    offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(c.channel, idC, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    // B walks out while still queued, then A finishes.
    leave('b', b.peerId);
    await flush(1);
    expect(manager.getLeaseState(idB)).toBe('FINALIZED');

    sendCancel(a.channel, idA);
    await flush(2);

    // C must be promoted — B's dead lease may not hold the queue.
    expect(manager.getLeaseState(idC)).toBe('ACTIVE');
    expect(c.channel.acceptedIds()).toEqual([idC]);

    sendCancel(c.channel, idC);
    await flush(1);
    expect(manager.getActiveTransferCount()).toBe(0);
  });

  it('a stalled transfer is timed out by the shop and the next customer proceeds', async () => {
    vi.useFakeTimers();
    try {
      const { manager, joinCustomer } = createShop({ transferWatchdogMs: 500 });
      const a = joinCustomer('a');
      const b = joinCustomer('b');
      const idA = id();
      const idB = id();

      offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
      offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getLeaseState(idA)).toBe('ACTIVE');

      await vi.advanceTimersByTimeAsync(600);

      expect(manager.getLeaseState(idA)).toBe('FINALIZED');
      expect(a.channel.cancelledIds()).toContain(idA); // A's sender is told, not left hanging
      expect(manager.getLeaseState(idB)).toBe('ACTIVE');
      expect(b.channel.acceptedIds()).toEqual([idB]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a promoted customer whose channel already died releases the slot at once, not after the watchdog', async () => {
    // The subtle one. A dead DataChannel does NOT throw on send — FileReceiver returns
    // false — so a try/catch around accept() cannot see this. If the failure is not
    // detected, B's slot is held for the FULL watchdog timeout (45s in production) and
    // C waits behind a customer who is already gone. B must be released synchronously,
    // inside the same dequeue pass, so C starts immediately.
    vi.useFakeTimers();
    try {
      const { manager, joinCustomer, events } = createShop({ transferWatchdogMs: 500 });
      const a = joinCustomer('a');
      const b = joinCustomer('b');
      const c = joinCustomer('c');
      const idA = id();
      const idB = id();
      const idC = id();

      offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
      offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
      offerFile(c.channel, idC, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getLeaseState(idA)).toBe('ACTIVE');

      // B's transport dies while queued, WITHOUT a PEER_LEFT — the phone slept, or the
      // socket has not been reaped yet. The shop still believes B is connected.
      b.channel.close();

      sendCancel(a.channel, idA);
      await vi.advanceTimersByTimeAsync(1);

      // No timer advanced past the watchdog: C is running already.
      expect(manager.getLeaseState(idB)).toBe('FINALIZED');
      expect(manager.getLeaseState(idC)).toBe('ACTIVE');
      expect(c.channel.acceptedIds()).toEqual([idC]);
      expect(manager.getActiveTransferCount()).toBe(1);
      expect(events.onError).toHaveBeenCalledWith('b', expect.stringMatching(/connection lost/i));

      // And the queue still drains cleanly afterwards.
      sendCancel(c.channel, idC);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getActiveTransferCount()).toBe(0);
      expect(manager.getQueuedTransferIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Isolation ───────────────────────────────────────────────────────────────

describe('customers are isolated from each other (scenario 21)', () => {
  it("B's WebRTC failure does not touch A's session, transfer or documents", async () => {
    const { manager, joinCustomer, failWebRTC, events } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');

    await completeFile(a.channel, id(), { name: 'a-kept.pdf' });
    const aDocsBefore = [...manager.getCustomer('a')!.documents.values()];

    const idA2 = id();
    const bytesA2 = await offerRealFile(a.channel, idA2, { name: 'a-inflight.pdf' });
    const idB = id();
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    failWebRTC(b, 'failed');
    await flush(2);

    // B's queued work is released; A's stays exactly as it was.
    expect(manager.getLeaseState(idB)).toBe('FINALIZED');
    expect(manager.getLeaseState(idA2)).toBe('ACTIVE');
    expect(manager.getCustomer('a')!.connectionState).toBe('CONNECTED');
    expect([...manager.getCustomer('a')!.documents.values()]).toEqual(aDocsBefore);
    expect(a.channel.cancelledIds()).toEqual([]); // A was never told to stop
    expect(a.peer.close).not.toHaveBeenCalled();
    expect(events.onError.mock.calls.every((call) => call[0] !== 'a')).toBe(true);

    // …and A can still finish.
    await finishFile(a.channel, idA2, bytesA2);
    expect(manager.getCustomer('a')!.documents.size).toBe(2);
  });

  it("closing B's DataChannel leaves A's receiver alive", async () => {
    const { manager, joinCustomer } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');

    b.channel.close();
    b.peer.opts.onDataChannelClosed();
    await flush(1);

    expect(manager.getCustomer('b')!.receiver).toBeNull();
    expect(manager.getCustomer('a')!.receiver).not.toBeNull();

    await completeFile(a.channel, id());
    expect(manager.getCustomer('a')!.documents.size).toBe(1);
  });

  it("a late callback from a superseded peer cannot mutate the customer that replaced it", async () => {
    const { manager, joinCustomer } = createShop();
    const first = joinCustomer('a', { peerId: 'peer-a-1' });
    await completeFile(first.channel, id());

    // A reconnects on a new transport.
    const second = joinCustomer('a', { peerId: 'peer-a-2' });
    expect(manager.getCustomer('a')!.peerId).toBe('peer-a-2');

    // The dead peer's callbacks fire late — they must be ignored.
    first.peer.opts.onConnectionStateChange('failed');
    first.peer.opts.onDataChannelClosed();
    await flush(1);

    expect(manager.getCustomer('a')!.connectionState).toBe('CONNECTED');
    expect(manager.getCustomer('a')!.receiver).not.toBeNull();
    expect(manager.getCustomer('a')!.documents.size).toBe(1);
    void second;
  });
});

// ─── Identity and attribution ────────────────────────────────────────────────

describe('document attribution is durable (scenarios 9, 10, 11, 12, 20, 25, 26)', () => {
  it("9 & 10. A's document survives B joining, and then C joining", async () => {
    const { manager, joinCustomer } = createShop();
    const a = joinCustomer('a', { customerCode: '1234', displayName: 'Rahul' });

    await completeFile(a.channel, id(), { name: 'a-resume.pdf' });
    const docA = [...manager.getCustomer('a')!.documents.values()][0];
    expect(docA.clientId).toBe('a');

    joinCustomer('b', { customerCode: '5678' });
    expect([...manager.getCustomer('a')!.documents.values()][0]).toBe(docA);

    joinCustomer('c', { customerCode: '9012' });
    expect([...manager.getCustomer('a')!.documents.values()][0]).toBe(docA);
    expect(manager.getCustomers()).toHaveLength(3);
  });

  it('11. attribution stamped on a document is never rewritten by later events', async () => {
    const { manager, joinCustomer, signaling } = createShop();
    const a = joinCustomer('a', { customerCode: '1234', displayName: 'Rahul', batchId: 'batch-A82F' });

    await completeFile(a.channel, id(), { name: 'a-resume.pdf' });
    const doc = [...manager.getCustomer('a')!.documents.values()][0];

    expect(doc.customerCode).toBe('1234');
    expect(doc.displayName).toBe('Rahul');
    expect(doc.batchId).toBe('batch-A82F');

    // Another customer arrives and A renames themselves; the stored document keeps the
    // attribution it was received with, and still resolves to A.
    joinCustomer('b', { customerCode: '5678', displayName: 'Meera' });
    signaling.emit('customer_updated', { peerId: a.peerId, clientId: 'a', displayName: 'Rahul K.' });

    expect(doc.clientId).toBe('a');
    expect(doc.customerCode).toBe('1234');
    expect(doc.batchId).toBe('batch-A82F');
    expect(manager.getCustomer('a')!.displayName).toBe('Rahul K.');
    expect(manager.getCustomer('b')!.displayName).toBe('Meera');
  });

  it("12 & 26. every document carries its own sender's clientId after all three finish", async () => {
    const { manager, joinCustomer, events } = createShop();
    const a = joinCustomer('a', { customerCode: '1234' });
    const b = joinCustomer('b', { customerCode: '5678' });
    const c = joinCustomer('c', { customerCode: '9012' });

    // Everyone offers everything up front; the queue decides the order.
    const plan: Array<{ cid: string; channel: typeof a.channel; transferId: string; bytes: Uint8Array }> = [];
    for (const who of [a, b, c]) {
      for (let n = 1; n <= 3; n++) {
        const transferId = id();
        const bytes = await offerRealFile(who.channel, transferId, {
          name: `${who.clientId}-doc${n}.pdf`,
        });
        plan.push({ cid: who.clientId, channel: who.channel, transferId, bytes });
      }
    }
    expect(manager.getActiveTransferCount()).toBe(1); // still only one at a time

    // Finish them in a deliberately jumbled order.
    for (const step of [...plan].reverse()) {
      await finishFile(step.channel, step.transferId, step.bytes);
    }

    expect(events.onFileReceived).toHaveBeenCalledTimes(9);
    for (const cid of ['a', 'b', 'c']) {
      const docs = [...manager.getCustomer(cid)!.documents.values()];
      expect(docs).toHaveLength(3); // 25. multiple documents per customer
      expect(docs.every((d) => d.clientId === cid)).toBe(true);
      expect(docs.every((d) => d.customerCode === manager.getCustomer(cid)!.customerCode)).toBe(true);
      expect(docs.every((d) => d.name.startsWith(`${cid}-doc`))).toBe(true);
      expect(new Set(docs.map((d) => d.documentId)).size).toBe(3);
    }

    expect(manager.getDocuments()).toHaveLength(9);
    expect(manager.getActiveTransferCount()).toBe(0);
    expect(manager.getQueuedTransferIds()).toEqual([]);
  });

  it('20. a duplicate PEER_JOINED for the same clientId replaces the peer, not the customer', async () => {
    const { manager, joinCustomer, events, peerLog } = createShop();
    const first = joinCustomer('a', { customerCode: '1234', peerId: 'peer-a-1' });
    await completeFile(first.channel, id(), { name: 'kept.pdf' });

    const before = manager.getCustomer('a')!;
    const second = joinCustomer('a', { customerCode: '1234', peerId: 'peer-a-2' });

    // One logical customer, same session object, history intact.
    expect(manager.getCustomers()).toHaveLength(1);
    expect(manager.getCustomer('a')).toBe(before);
    expect(manager.getCustomer('a')!.documents.size).toBe(1);
    expect(manager.getCustomer('a')!.peerId).toBe('peer-a-2');

    // The old transport was torn down; a new one was built.
    expect(first.peer.close).toHaveBeenCalled();
    expect(peerLog).toHaveLength(2);
    expect(second.peer.startOffer).toHaveBeenCalledWith('peer-a-2');

    // Joined once, updated on the rejoin — the dashboard is told to merge, not to add.
    expect(events.onCustomerJoined).toHaveBeenCalledTimes(1);
    expect(events.onCustomerUpdated).toHaveBeenCalled();
  });

  it('a PEER_LEFT followed by a PEER_JOINED (socket blip) keeps one customer and their documents', async () => {
    const { manager, joinCustomer, leave } = createShop();
    const first = joinCustomer('a', { peerId: 'peer-a-1' });
    await completeFile(first.channel, id(), { name: 'kept.pdf' });

    // Exactly the server's reconnect sequence.
    leave('a', 'peer-a-1');
    const again = joinCustomer('a', { peerId: 'peer-a-2' });
    await flush(1);

    expect(manager.getCustomers()).toHaveLength(1);
    expect(manager.getCustomer('a')!.connectionState).toBe('CONNECTED');
    expect(manager.getCustomer('a')!.documents.size).toBe(1);

    // And the reconnected customer can send again, into the same batch.
    await completeFile(again.channel, id(), { name: 'second.pdf' });
    const docs = [...manager.getCustomer('a')!.documents.values()];
    expect(docs).toHaveLength(2);
    expect(new Set(docs.map((d) => d.batchId)).size).toBe(1);
  });

  it('a duplicate FILE_OFFER for the same transferId never takes a second slot', async () => {
    const { manager, joinCustomer } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const idA = id();

    offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    offerFile(a.channel, idA, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    expect(manager.getActiveTransferCount()).toBe(1);

    const idB = id();
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);
    expect(manager.getQueuedTransferIds()).toEqual([idB]);
  });

  it('the batch status of each customer is derived independently', async () => {
    const { manager, joinCustomer } = createShop();
    const a = joinCustomer('a');
    const b = joinCustomer('b');
    const c = joinCustomer('c');

    expect(manager.getCustomer('c')!.batchStatus).toBe('EMPTY');

    await completeFile(a.channel, id());
    const idB = id();
    offerFile(b.channel, idB, { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    expect(manager.getCustomer('a')!.batchStatus).toBe('READY_TO_PRINT');
    expect(manager.getCustomer('b')!.batchStatus).toBe('RECEIVING');
    expect(manager.getCustomer('c')!.batchStatus).toBe('EMPTY'); // connected, sent nothing
    void c;
  });
});

// ─── Diagnostics ─────────────────────────────────────────────────────────────

describe('real-device diagnostics are structured and off by default', () => {
  it('emits the documented [QD] tags when enabled', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    setTransferQueueLogging(true);

    const { joinCustomer } = createShop();
    const a = joinCustomer('a', { customerCode: '1234' });
    offerFile(a.channel, id(), { size: 1024, totalChunks: 1, sha256: ZERO_SHA });
    await flush(1);

    const qd = lines.filter((l) => l.startsWith('[QD]'));
    expect(qd.some((l) => /^\[QD\]\[WS\] clientId=\S+ peerId=\S+ event=PEER_JOINED$/.test(l))).toBe(true);
    expect(
      qd.some((l) =>
        /^\[QD\]\[CUSTOMER\] clientId=\S+ peerId=\S+ customerCode=1234 batchId=\S+ event=JOINED$/.test(l),
      ),
    ).toBe(true);
    expect(qd.some((l) => /^\[QD\]\[WEBRTC\] clientId=\S+ peerId=\S+ connectionState=connected$/.test(l))).toBe(true);
    expect(
      qd.some((l) => /^\[QD\]\[TRANSFER\] clientId=\S+ batchId=\S+ transferId=\S+ fileName=\S* state=ACTIVE$/.test(l)),
    ).toBe(true);
    expect(qd.some((l) => /^\[QD\]\[QUEUE\] active=1 queued=0 next=none/.test(l))).toBe(true);
  });

  it('emits nothing once disabled, so production stays quiet', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    setTransferQueueLogging(false);

    const { joinCustomer, leave } = createShop();
    const a = joinCustomer('a');
    await completeFile(a.channel, id());
    leave('a', a.peerId);
    await flush(1);

    expect(lines.filter((l) => l.startsWith('[QD]'))).toEqual([]);
  });
});
