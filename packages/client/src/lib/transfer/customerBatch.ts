import { LIMITS, TransferProgress } from '@quickdrop/shared';

/**
 * The customer's batch as a durable, refresh-survivable model.
 *
 * Two rules shape this module:
 *
 * 1. **Stable identity per file.** Entries are keyed by `fileId`, not by array index.
 *    Index keying is what let a failed or removed file shift every later file's
 *    progress row onto the wrong document.
 *
 * 2. **Metadata only crosses a refresh.** A `File` is a handle to bytes the page does
 *    not own; it cannot be serialized, and copying the bytes into web storage would
 *    violate the privacy model (nothing of the customer's document is ever persisted).
 *    So a reload restores the batch's *state* and marks any file whose handle died
 *    `FILE_RESELECT_REQUIRED` — an explicit, actionable status instead of a 0-byte row
 *    that silently never sends.
 */

export type BatchFileStatus =
  | 'PENDING' // chosen by the customer, not yet offered to the shop
  | TransferProgress['status']
  | 'FILE_RESELECT_REQUIRED'; // state survived a refresh; the File handle did not

/** Statuses from which no further work will happen without user action. */
const TERMINAL: ReadonlySet<BatchFileStatus> = new Set<BatchFileStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export interface BatchFileEntry {
  /** Durable key. Survives refresh; never an array index. */
  fileId: string;
  name: string;
  size: number;
  mime: string;
  lastModified: number;
  status: BatchFileStatus;
  /** Set once this file has been offered; null while PENDING. */
  transferId: string | null;
  percentage: number;
  transferredBytes: number;
  error?: string;
  /**
   * Live handle to the customer's bytes. NEVER serialized, and null after a refresh —
   * check this, not `status`, before attempting to send.
   */
  file: File | null;
}

/** What actually goes to sessionStorage: everything above except `file`. */
export type PersistedBatchFile = Omit<BatchFileEntry, 'file'>;

export interface PersistedBatch {
  version: 1;
  clientId: string;
  customerCode: string;
  batchId: string;
  displayName: string | null;
  numericCode: string | null;
  token: string | null;
  isBatchCompleted: boolean;
  files: PersistedBatchFile[];
}

export const BATCH_STORAGE_VERSION = 1 as const;

// ─── Construction ──────────────────────────────────────────────────────────────

export function createBatchEntry(file: File): BatchFileEntry {
  return {
    fileId: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    lastModified: file.lastModified,
    status: 'PENDING',
    transferId: null,
    percentage: 0,
    transferredBytes: 0,
    file,
  };
}

/** Append newly picked files. Existing entries are untouched, including their state. */
export function addFiles(
  prev: readonly BatchFileEntry[],
  files: readonly File[],
): BatchFileEntry[] {
  return [...prev, ...files.map(createBatchEntry)];
}

export function removeFile(
  prev: readonly BatchFileEntry[],
  fileId: string,
): BatchFileEntry[] {
  return prev.filter((e) => e.fileId !== fileId);
}

// ─── Progress ──────────────────────────────────────────────────────────────────

/**
 * Fold one {@link TransferProgress} into the entry it belongs to, matched by fileId.
 * Every other entry is returned by reference — one file's progress can never
 * overwrite another's row.
 */
export function applyProgress(
  prev: readonly BatchFileEntry[],
  fileId: string,
  progress: TransferProgress,
): BatchFileEntry[] {
  const index = prev.findIndex((e) => e.fileId === fileId);
  if (index === -1) return prev.slice();
  const next = prev.slice();
  next[index] = {
    ...next[index],
    status: progress.status,
    transferId: progress.transferId,
    percentage: progress.percentage,
    transferredBytes: progress.transferredBytes,
    error: progress.error,
  };
  return next;
}

/** Force one entry to a terminal FAILED row — used when a file can't even be offered. */
export function markFailed(
  prev: readonly BatchFileEntry[],
  fileId: string,
  error: string,
): BatchFileEntry[] {
  const index = prev.findIndex((e) => e.fileId === fileId);
  if (index === -1) return prev.slice();
  const next = prev.slice();
  next[index] = { ...next[index], status: 'FAILED', error };
  return next;
}

/**
 * Files that should be sent on the next "Send" press: never-offered ones plus
 * previously failed ones that still have live bytes to retry from.
 */
export function sendableEntries(entries: readonly BatchFileEntry[]): BatchFileEntry[] {
  return entries.filter(
    (e) => e.file !== null && (e.status === 'PENDING' || e.status === 'FAILED' || e.status === 'CANCELLED'),
  );
}

export function reselectRequiredEntries(entries: readonly BatchFileEntry[]): BatchFileEntry[] {
  return entries.filter((e) => e.status === 'FILE_RESELECT_REQUIRED');
}

export function completedEntries(entries: readonly BatchFileEntry[]): BatchFileEntry[] {
  return entries.filter((e) => e.status === 'COMPLETED');
}

export function isTerminal(status: BatchFileStatus): boolean {
  return TERMINAL.has(status);
}

// ─── Persistence (metadata only) ───────────────────────────────────────────────

export function toPersistedFile(entry: BatchFileEntry): PersistedBatchFile {
  // Destructuring `file` off is the whole point: nothing derived from the document's
  // bytes may reach storage.
  const { file: _file, ...rest } = entry;
  return rest;
}

export function serializeBatch(input: {
  clientId: string;
  customerCode: string;
  batchId: string;
  displayName: string | null;
  numericCode: string | null;
  token: string | null;
  isBatchCompleted: boolean;
  entries: readonly BatchFileEntry[];
}): PersistedBatch {
  return {
    version: BATCH_STORAGE_VERSION,
    clientId: input.clientId,
    customerCode: input.customerCode,
    batchId: input.batchId,
    displayName: input.displayName,
    numericCode: input.numericCode,
    token: input.token,
    isBatchCompleted: input.isBatchCompleted,
    files: input.entries.slice(0, LIMITS.MAX_FILES_PER_SESSION).map(toPersistedFile),
  };
}

/**
 * Rehydrate a persisted entry.
 *
 * COMPLETED files stay COMPLETED — the shop already holds those bytes and has verified
 * them, so the customer's record of them must not be reset (nor do they need a File
 * handle again). Everything else lost its bytes with the page, so regardless of whether
 * it was PENDING, QUEUED, mid-SENDING or FAILED, it becomes FILE_RESELECT_REQUIRED. Any
 * error text from the previous attempt is kept so the customer still sees *why*.
 */
export function restoreEntry(persisted: PersistedBatchFile): BatchFileEntry {
  if (persisted.status === 'COMPLETED') {
    return { ...persisted, percentage: 100, transferredBytes: persisted.size, file: null };
  }
  return {
    ...persisted,
    status: 'FILE_RESELECT_REQUIRED',
    percentage: 0,
    transferredBytes: 0,
    file: null,
  };
}

export function restoreBatchEntries(persisted: readonly PersistedBatchFile[]): BatchFileEntry[] {
  return persisted.map(restoreEntry);
}

/**
 * Re-attach freshly picked File objects to the entries waiting for them.
 *
 * A file matches an awaiting entry when name and size agree — enough to be confident
 * it is the same document, and all the browser gives us to compare. Matched entries go
 * back to PENDING with their ORIGINAL fileId, so the batch keeps one row per document
 * instead of accumulating a duplicate on every reselect. Files that match nothing are
 * simply added (the customer may be adding more documents, not restoring old ones).
 */
export function attachReselectedFiles(
  prev: readonly BatchFileEntry[],
  files: readonly File[],
): { entries: BatchFileEntry[]; matched: number; added: number } {
  const next = prev.slice();
  let matched = 0;
  const leftovers: File[] = [];

  for (const file of files) {
    const index = next.findIndex(
      (e) =>
        e.status === 'FILE_RESELECT_REQUIRED' &&
        e.file === null &&
        e.name === file.name &&
        e.size === file.size,
    );
    if (index === -1) {
      leftovers.push(file);
      continue;
    }
    next[index] = {
      ...next[index],
      status: 'PENDING',
      transferId: null,
      percentage: 0,
      transferredBytes: 0,
      error: undefined,
      lastModified: file.lastModified,
      mime: file.type || next[index].mime,
      file,
    };
    matched++;
  }

  return {
    entries: [...next, ...leftovers.map(createBatchEntry)],
    matched,
    added: leftovers.length,
  };
}

/**
 * Parse a stored snapshot defensively: anything malformed, from another version, or
 * missing its identity is discarded rather than half-applied. A dropped snapshot only
 * costs the customer a reselect; a half-applied one could mis-attribute a document.
 */
export function parsePersistedBatch(raw: string | null): PersistedBatch | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const candidate = parsed as Partial<PersistedBatch>;
  if (candidate.version !== BATCH_STORAGE_VERSION) return null;
  if (typeof candidate.clientId !== 'string' || !candidate.clientId) return null;
  if (!Array.isArray(candidate.files)) return null;

  const files: PersistedBatchFile[] = [];
  for (const entry of candidate.files) {
    if (
      typeof entry?.fileId !== 'string' ||
      typeof entry?.name !== 'string' ||
      typeof entry?.size !== 'number' ||
      typeof entry?.status !== 'string'
    ) {
      continue; // skip the bad row, keep the good ones
    }
    files.push({
      fileId: entry.fileId,
      name: entry.name,
      size: entry.size,
      mime: typeof entry.mime === 'string' ? entry.mime : 'application/octet-stream',
      lastModified: typeof entry.lastModified === 'number' ? entry.lastModified : 0,
      status: entry.status as BatchFileStatus,
      transferId: typeof entry.transferId === 'string' ? entry.transferId : null,
      percentage: typeof entry.percentage === 'number' ? entry.percentage : 0,
      transferredBytes: typeof entry.transferredBytes === 'number' ? entry.transferredBytes : 0,
      ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
    });
  }

  return {
    version: BATCH_STORAGE_VERSION,
    clientId: candidate.clientId,
    customerCode: typeof candidate.customerCode === 'string' ? candidate.customerCode : '',
    batchId: typeof candidate.batchId === 'string' ? candidate.batchId : '',
    displayName: typeof candidate.displayName === 'string' ? candidate.displayName : null,
    numericCode: typeof candidate.numericCode === 'string' ? candidate.numericCode : null,
    token: typeof candidate.token === 'string' ? candidate.token : null,
    isBatchCompleted: candidate.isBatchCompleted === true,
    files,
  };
}

/** Human-readable summary for the reselect banner. */
export function describeReselect(entries: readonly BatchFileEntry[]): string | null {
  const pending = reselectRequiredEntries(entries);
  if (pending.length === 0) return null;
  const names = pending.map((e) => e.name);
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}
