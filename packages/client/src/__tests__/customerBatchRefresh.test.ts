/**
 * Regression suite for customer-page refresh (real-device bug 3).
 *
 * Observed: pulling to refresh the customer page lost everything — a new clientId, a
 * second batch, completed documents forgotten, and files stuck showing "0 B" in a queue
 * that would never move, because a `File` handle cannot survive a reload and nothing
 * noticed that it hadn't.
 *
 * Two constraints shape the fix and therefore these tests:
 *
 *   1. Identity and state must survive: clientId, customerCode, batchId, displayName,
 *      numericCode, completed/failed/queued file metadata.
 *   2. Document BYTES must never be persisted. Browser storage holds metadata only, so
 *      a file whose handle died is explicitly marked FILE_RESELECT_REQUIRED and the
 *      customer is told which files to pick again — never silently left at 0 B.
 *
 * Covers scenarios 13, 14, 15, 16 and 17 of the regression matrix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LIMITS, TransferProgress } from '@quickdrop/shared';
import {
  BATCH_STORAGE_VERSION,
  BatchFileEntry,
  BatchFileStatus,
  addFiles,
  applyProgress,
  attachReselectedFiles,
  completedEntries,
  describeReselect,
  isTerminal,
  markFailed,
  parsePersistedBatch,
  removeFile,
  reselectRequiredEntries,
  restoreBatchEntries,
  sendableEntries,
  serializeBatch,
  toPersistedFile,
} from '../lib/transfer/customerBatch.js';

beforeEach(() => {
  if (!globalThis.crypto) {
    globalThis.crypto = require('node:crypto').webcrypto as any;
  }
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const IDENTITY = {
  clientId: 'client-7f3a',
  customerCode: '1234',
  batchId: 'batch-A82F',
  displayName: 'Rahul',
  numericCode: '482913',
  token: 'session-token-abc',
  isBatchCompleted: false,
};

function makeFile(name: string, size = 2048, mime = 'application/pdf'): File {
  return new File([new Uint8Array(size)], name, { type: mime, lastModified: 1_700_000_000_000 });
}

function progressFor(entry: BatchFileEntry, overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    transferId: `tr-${entry.fileId}`,
    fileName: entry.name,
    fileSize: entry.size,
    transferredBytes: entry.size,
    percentage: 100,
    speedBytesPerSec: 1024,
    estimatedRemainingSec: 0,
    status: 'COMPLETED',
    ...overrides,
  };
}

/** Serialize → store → reload → parse → rehydrate: exactly what a refresh does. */
function refresh(entries: readonly BatchFileEntry[], identity = IDENTITY) {
  const raw = JSON.stringify(serializeBatch({ ...identity, entries }));
  const snapshot = parsePersistedBatch(raw);
  expect(snapshot).not.toBeNull();
  return { raw, snapshot: snapshot!, entries: restoreBatchEntries(snapshot!.files) };
}

// ─── Identity ─────────────────────────────────────────────────────────────────

describe('refresh preserves customer identity (scenarios 13, 14, 15)', () => {
  it('restores the same clientId — never mints a new one', () => {
    const { snapshot } = refresh(addFiles([], [makeFile('resume.pdf')]));
    expect(snapshot.clientId).toBe(IDENTITY.clientId);
  });

  it('restores the same batchId — never opens a second batch', () => {
    const { snapshot } = refresh(addFiles([], [makeFile('resume.pdf')]));
    expect(snapshot.batchId).toBe(IDENTITY.batchId);
  });

  it('restores customerCode, displayName and the session numericCode', () => {
    const { snapshot } = refresh([]);
    expect(snapshot.customerCode).toBe('1234');
    expect(snapshot.displayName).toBe('Rahul');
    expect(snapshot.numericCode).toBe('482913');
    expect(snapshot.token).toBe('session-token-abc');
  });

  it('is idempotent: refreshing repeatedly yields one row per document, with stable ids', () => {
    const first = addFiles([], [makeFile('a.pdf'), makeFile('b.jpg')]);
    const ids = first.map((e) => e.fileId);

    const once = refresh(first).entries;
    const twice = refresh(once).entries;
    const thrice = refresh(twice).entries;

    expect(thrice).toHaveLength(2);
    expect(thrice.map((e) => e.fileId)).toEqual(ids); // no duplicate rows accumulating
  });

  it('a snapshot belonging to a different clientId is identifiable and can be rejected', () => {
    // The page only adopts a snapshot whose clientId matches its own; this is the check
    // that stops one customer's state being restored onto another's session.
    const { snapshot } = refresh([], { ...IDENTITY, clientId: 'someone-else' });
    expect(snapshot.clientId).not.toBe(IDENTITY.clientId);
  });
});

// ─── Completed metadata ───────────────────────────────────────────────────────

describe('refresh does not reset completed work (scenario 16)', () => {
  it('a COMPLETED file stays COMPLETED at 100%, with its transferId', () => {
    let entries = addFiles([], [makeFile('done.pdf', 4096)]);
    entries = applyProgress(entries, entries[0].fileId, progressFor(entries[0]));
    expect(entries[0].status).toBe('COMPLETED');

    const restored = refresh(entries).entries;

    expect(restored[0].status).toBe('COMPLETED');
    expect(restored[0].percentage).toBe(100);
    expect(restored[0].transferredBytes).toBe(4096);
    expect(restored[0].transferId).toBe(`tr-${entries[0].fileId}`);
    expect(completedEntries(restored)).toHaveLength(1);
  });

  it('a completed file needs no reselect — the shop already holds and verified those bytes', () => {
    let entries = addFiles([], [makeFile('done.pdf')]);
    entries = applyProgress(entries, entries[0].fileId, progressFor(entries[0]));

    const restored = refresh(entries).entries;

    expect(reselectRequiredEntries(restored)).toHaveLength(0);
    expect(describeReselect(restored)).toBeNull();
  });

  it('keeps completed rows while marking the unsent ones for reselect, in one batch', () => {
    let entries = addFiles([], [makeFile('sent.pdf'), makeFile('pending.pdf')]);
    entries = applyProgress(entries, entries[0].fileId, progressFor(entries[0]));

    const restored = refresh(entries).entries;

    expect(restored.map((e) => e.status)).toEqual(['COMPLETED', 'FILE_RESELECT_REQUIRED']);
    expect(restored).toHaveLength(2);
  });
});

// ─── Unrecoverable file handles ───────────────────────────────────────────────

describe('a File handle that cannot survive the reload becomes explicit (scenario 17)', () => {
  const NON_TERMINAL: BatchFileStatus[] = [
    'PENDING',
    'QUEUED',
    'HASHING',
    'SENDING',
    'VERIFYING',
    'FAILED',
    'CANCELLED',
  ];

  it.each(NON_TERMINAL)('a %s file restores as FILE_RESELECT_REQUIRED with no handle', (status) => {
    const entries = addFiles([], [makeFile('in-flight.pdf')]);
    const staged: BatchFileEntry[] = [{ ...entries[0], status, percentage: 42, transferredBytes: 900 }];

    const restored = refresh(staged).entries;

    expect(restored[0].status).toBe('FILE_RESELECT_REQUIRED');
    expect(restored[0].file).toBeNull();
    expect(restored[0].percentage).toBe(0); // not a stale 42% that will never move
    expect(restored[0].transferredBytes).toBe(0);
  });

  it('keeps the previous error text so the customer still sees why it failed', () => {
    let entries = addFiles([], [makeFile('bad.pdf')]);
    entries = markFailed(entries, entries[0].fileId, 'Checksum mismatch');

    const restored = refresh(entries).entries;

    expect(restored[0].status).toBe('FILE_RESELECT_REQUIRED');
    expect(restored[0].error).toBe('Checksum mismatch');
  });

  it('a reselect-required row is NOT sendable — it cannot sit in the queue forever', () => {
    const entries = refresh(addFiles([], [makeFile('gone.pdf')])).entries;
    expect(sendableEntries(entries)).toHaveLength(0);
  });

  it('names the files to pick again, and summarises long lists', () => {
    const four = refresh(
      addFiles([], [makeFile('a.pdf'), makeFile('b.pdf'), makeFile('c.pdf'), makeFile('d.pdf')]),
    ).entries;

    expect(describeReselect(four)).toBe('a.pdf, b.pdf, c.pdf and 1 more');
    expect(describeReselect(four.slice(0, 2))).toBe('a.pdf, b.pdf');
  });

  it('re-picking a file revives the ORIGINAL row instead of adding a duplicate', () => {
    const original = addFiles([], [makeFile('resume.pdf', 2048)]);
    const originalId = original[0].fileId;
    const stale = refresh(original).entries;

    const { entries, matched, added } = attachReselectedFiles(stale, [makeFile('resume.pdf', 2048)]);

    expect(matched).toBe(1);
    expect(added).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].fileId).toBe(originalId); // same document, same row
    expect(entries[0].status).toBe('PENDING');
    expect(entries[0].file).not.toBeNull();
    expect(entries[0].error).toBeUndefined();
    expect(sendableEntries(entries)).toHaveLength(1);
  });

  it('a genuinely new file picked at the same time is appended, not matched', () => {
    const stale = refresh(addFiles([], [makeFile('resume.pdf', 2048)])).entries;

    const { entries, matched, added } = attachReselectedFiles(stale, [
      makeFile('resume.pdf', 2048),
      makeFile('id-card.jpg', 900),
    ]);

    expect(matched).toBe(1);
    expect(added).toBe(1);
    expect(entries).toHaveLength(2);
    expect(entries[1].name).toBe('id-card.jpg');
  });

  it('a same-named file of a different size does not silently satisfy the reselect', () => {
    const stale = refresh(addFiles([], [makeFile('resume.pdf', 2048)])).entries;

    const { entries, matched } = attachReselectedFiles(stale, [makeFile('resume.pdf', 9999)]);

    expect(matched).toBe(0);
    expect(entries).toHaveLength(2);
    expect(reselectRequiredEntries(entries)).toHaveLength(1);
  });

  it('two reselect rows with identical name and size are matched one-for-one', () => {
    const stale = refresh(addFiles([], [makeFile('scan.jpg', 512), makeFile('scan.jpg', 512)])).entries;

    const { entries, matched, added } = attachReselectedFiles(stale, [
      makeFile('scan.jpg', 512),
      makeFile('scan.jpg', 512),
    ]);

    expect(matched).toBe(2);
    expect(added).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.file !== null && e.status === 'PENDING')).toBe(true);
  });
});

// ─── Storage hygiene ──────────────────────────────────────────────────────────

describe('storage holds metadata only — never document bytes', () => {
  it('a persisted entry has no file handle at all', () => {
    const entries = addFiles([], [makeFile('secret.pdf')]);
    const persisted = toPersistedFile(entries[0]);
    expect('file' in persisted).toBe(false);
  });

  it('the serialized snapshot contains no "file" key and no payload bytes', () => {
    const bytes = new Uint8Array(32).fill(7);
    const file = new File([bytes], 'secret.pdf', { type: 'application/pdf' });
    const { raw } = refresh(addFiles([], [file]));

    expect(raw).not.toContain('"file"');
    expect(raw).not.toContain('\\u0007');
    // Metadata is all that survives.
    expect(raw).toContain('secret.pdf');
    expect(JSON.parse(raw).version).toBe(BATCH_STORAGE_VERSION);
  });

  it('never stores more rows than a session may hold', () => {
    const many = addFiles(
      [],
      Array.from({ length: LIMITS.MAX_FILES_PER_SESSION + 5 }, (_, i) => makeFile(`f${i}.pdf`)),
    );
    const snapshot = serializeBatch({ ...IDENTITY, entries: many });
    expect(snapshot.files).toHaveLength(LIMITS.MAX_FILES_PER_SESSION);
  });
});

// ─── Defensive parsing ────────────────────────────────────────────────────────

describe('a corrupt or foreign snapshot is discarded, never half-applied', () => {
  it.each([
    ['nothing stored', null],
    ['not JSON', 'definitely-not-json'],
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['an unknown version', JSON.stringify({ version: 99, clientId: 'x', files: [] })],
    ['no clientId', JSON.stringify({ version: 1, files: [] })],
    ['an empty clientId', JSON.stringify({ version: 1, clientId: '', files: [] })],
    ['files that are not an array', JSON.stringify({ version: 1, clientId: 'x', files: {} })],
  ])('rejects %s', (_label, raw) => {
    expect(parsePersistedBatch(raw as string | null)).toBeNull();
  });

  it('skips a malformed row but keeps the sound ones', () => {
    const raw = JSON.stringify({
      version: 1,
      clientId: 'client-7f3a',
      files: [
        { fileId: 'ok', name: 'good.pdf', size: 10, status: 'COMPLETED' },
        { name: 'no-id.pdf', size: 10, status: 'PENDING' },
        { fileId: 'bad-size', name: 'x.pdf', size: 'huge', status: 'PENDING' },
      ],
    });

    const snapshot = parsePersistedBatch(raw)!;
    expect(snapshot.files.map((f) => f.fileId)).toEqual(['ok']);
  });

  it('fills in the defaults a sparse row omits', () => {
    const raw = JSON.stringify({
      version: 1,
      clientId: 'client-7f3a',
      files: [{ fileId: 'ok', name: 'good.pdf', size: 10, status: 'PENDING' }],
    });

    const [row] = parsePersistedBatch(raw)!.files;
    expect(row.mime).toBe('application/octet-stream');
    expect(row.transferId).toBeNull();
    expect(row.percentage).toBe(0);
    expect(row.lastModified).toBe(0);
    expect(row.error).toBeUndefined();
  });
});

// ─── fileId keying ────────────────────────────────────────────────────────────

describe('progress is keyed by fileId, never by array position', () => {
  it('removing a file cannot shift another file\'s progress onto the wrong row', () => {
    let entries = addFiles([], [makeFile('one.pdf'), makeFile('two.pdf'), makeFile('three.pdf')]);
    const third = entries[2];

    entries = removeFile(entries, entries[0].fileId); // indices all shift down
    entries = applyProgress(entries, third.fileId, progressFor(third, { status: 'SENDING', percentage: 30 }));

    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['three.pdf'].status).toBe('SENDING');
    expect(byName['three.pdf'].percentage).toBe(30);
    expect(byName['two.pdf'].status).toBe('PENDING'); // untouched
  });

  it('leaves every other entry byte-for-byte identical', () => {
    let entries = addFiles([], [makeFile('a.pdf'), makeFile('b.pdf')]);
    const untouched = entries[1];

    entries = applyProgress(entries, entries[0].fileId, progressFor(entries[0], { status: 'SENDING' }));

    expect(entries[1]).toBe(untouched);
  });

  it('progress for an unknown fileId changes nothing', () => {
    const entries = addFiles([], [makeFile('a.pdf')]);
    const next = applyProgress(entries, 'no-such-file', progressFor(entries[0]));
    expect(next).toEqual(entries);
  });

  it('marks only terminal statuses terminal', () => {
    const terminal: BatchFileStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
    const ongoing: BatchFileStatus[] = ['PENDING', 'QUEUED', 'SENDING', 'VERIFYING'];
    expect(terminal.every((s) => isTerminal(s))).toBe(true);
    expect(ongoing.some((s) => isTerminal(s))).toBe(false);
  });

  it('a failed file with live bytes stays retryable', () => {
    let entries = addFiles([], [makeFile('flaky.pdf')]);
    entries = markFailed(entries, entries[0].fileId, 'Network error');

    expect(sendableEntries(entries)).toHaveLength(1);
    expect(entries[0].file).not.toBeNull();
  });
});
