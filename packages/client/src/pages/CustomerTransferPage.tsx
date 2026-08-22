import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { TransferProgress } from '@quickdrop/shared';
import { FileSender } from '../lib/transfer/sender.js';
import { StatusIndicator, AppConnectionState } from '../components/StatusIndicator.js';
import { FilePicker } from '../components/FilePicker.js';
import { FileItemCard } from '../components/FileItemCard.js';
import { TransferProgressCard } from '../components/TransferProgressCard.js';
import { QrScannerModal } from '../components/QrScannerModal.js';
import type { QrScanResult } from '../lib/qr/qrValidator.js';
import {
  Send, CheckCircle2, ShieldCheck, RefreshCw, AlertCircle,
  KeyRound, ArrowRight, RotateCcw, Clock, Camera,
} from 'lucide-react';
import { ConnectionAttempt, ConnectionStage } from '../lib/webrtc/ConnectionAttempt.js';

// ─── Workflow state ────────────────────────────────────────────────────────────

export type CustomerWorkflowState =
  | 'INITIALIZING'
  | 'IDLE'           // No token — show scanner UI
  | 'CONNECTING'     // Active connection attempt in progress
  | 'IDENTITY_PROMPT'
  | 'BATCH_VIEW'
  | 'WAITING'
  | 'SENDING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'INTERRUPTED'
  | 'SESSION_EXPIRED'
  | 'SESSION_CLOSED'
  | 'SESSION_NOT_FOUND';

// ─── Stage labels ──────────────────────────────────────────────────────────────

const STAGE_LABELS: Partial<Record<ConnectionStage, string>> = {
  CONNECTING_WEBSOCKET: 'Connecting to QuickDrop server...',
  JOINING_SESSION: 'Joining shop session...',
  WAITING_FOR_SHOP: 'Waiting for shop to be ready...',
  NEGOTIATING_WEBRTC: 'Establishing secure P2P connection...',
  WAITING_FOR_ICE: 'Negotiating direct connection...',
  WAITING_FOR_DATA_CHANNEL: 'Opening secure data channel...',
};

// ─── SessionStorage helpers ────────────────────────────────────────────────────

const SS = {
  TOKEN: 'quickdrop_customer_token',
  CLIENT_ID: 'quickdrop_customer_client_id',
  CODE: 'quickdrop_customer_code',
  NUMERIC: 'quickdrop_customer_numeric',
  BATCH: 'quickdrop_customer_batch',
  NAME: 'quickdrop_customer_name',
} as const;

function clearSessionData() {
  sessionStorage.removeItem(SS.TOKEN);
  sessionStorage.removeItem(SS.CLIENT_ID);
  sessionStorage.removeItem(SS.CODE);
  sessionStorage.removeItem(SS.NUMERIC);
  sessionStorage.removeItem(SS.BATCH);
  sessionStorage.removeItem(SS.NAME);
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Props are supplied only when this page is hosted by the permanent-QR entry
 * (`/s/:publicShopId` → {@link ShopEntryPage}), which has already resolved the shop and
 * bridged to its current transfer session (spec §16). `initialNumericCode` is that
 * session's customer-join credential; when absent the page behaves exactly as before
 * (hash-token scan or stored-session reconnect).
 */
interface CustomerTransferPageProps {
  initialNumericCode?: string;
  initialShopName?: string;
}

export const CustomerTransferPage: React.FC<CustomerTransferPageProps> = ({
  initialNumericCode,
  initialShopName,
}) => {
  const navigate = useNavigate();
  const [token, setToken] = useState<string>('');
  const [manualCode, setManualCode] = useState<string>('');
  const [workflowState, setWorkflowState] = useState<CustomerWorkflowState>('INITIALIZING');
  const [connectionState, setConnectionState] = useState<AppConnectionState>('INITIALIZING');
  const [connectionStage, setConnectionStage] = useState<ConnectionStage>('IDLE');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [transferProgresses, setTransferProgresses] = useState<TransferProgress[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [customerCode, setCustomerCode] = useState<string>('');
  const [batchId, setBatchId] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [isBatchCompleted, setIsBatchCompleted] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const tokenRef = useRef<string>('');
  const isTransferringRef = useRef<boolean>(false);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  // The file currently being sent, so it can be cancelled if the session ends.
  const activeSenderRef = useRef<FileSender | null>(null);
  // Active signaling client — kept so identity-phase calls (updateCustomer, batchCompleted) work
  const signalingClientRef = useRef<import('../lib/webrtc/signalingClient.js').SignalingClient | null>(null);

  // ── Attempt tracking (stale-callback protection) ──────────────────────────
  const attemptIdRef = useRef<number>(0);
  const activeAttemptRef = useRef<ConnectionAttempt | null>(null);

  // ─── startNewAttempt ────────────────────────────────────────────────────────

  const startNewAttempt = useCallback((joinToken: string, numericCode?: string) => {
    // Abort any existing attempt first
    activeAttemptRef.current?.abort('superseded');
    activeAttemptRef.current = null;
    signalingClientRef.current = null;
    dataChannelRef.current = null;

    const id = ++attemptIdRef.current;
    const isCurrentAttempt = () => id === attemptIdRef.current;

    tokenRef.current = joinToken;
    setToken(joinToken);
    sessionStorage.setItem(SS.TOKEN, joinToken);
    // Persist the numeric backup code too, so a numericCode-only session (manual code or
    // the permanent-QR bridge §16) can rejoin after a reload — the join token alone does
    // not resolve those sessions server-side.
    if (numericCode) sessionStorage.setItem(SS.NUMERIC, numericCode);
    setErrorMsg(null);
    setWorkflowState('CONNECTING');
    setConnectionState('CONNECTING');
    setConnectionStage('CONNECTING_WEBSOCKET');

    const clientId = sessionStorage.getItem(SS.CLIENT_ID) || undefined;

    const attempt = new ConnectionAttempt({
      attemptId: id,
      isCurrentAttempt,
      joinToken,
      numericCode,
      clientId,
      callbacks: {
        onStageChange: (stage) => {
          if (!isCurrentAttempt()) return;
          console.log(`[QuickDrop][UI] stage=${stage}`);
          setConnectionStage(stage);
        },

        onSessionData: (code, batch) => {
          if (!isCurrentAttempt()) return;
          setCustomerCode(code);
          setBatchId(batch);
          sessionStorage.setItem(SS.CODE, code);
          sessionStorage.setItem(SS.BATCH, batch);
        },

        onConnected: (channel, code, batch) => {
          if (!isCurrentAttempt()) return;
          dataChannelRef.current = channel;
          // Keep a handle to the attempt's signaling client for post-connect calls
          signalingClientRef.current = activeAttemptRef.current?.getSignalingClient() ?? null;

          if (code) {
            setCustomerCode(code);
            sessionStorage.setItem(SS.CODE, code);
          }
          if (batch) {
            setBatchId(batch);
            sessionStorage.setItem(SS.BATCH, batch);
          }

          setConnectionState('READY');

          const storedName = sessionStorage.getItem(SS.NAME);
          setWorkflowState(storedName !== null ? 'BATCH_VIEW' : 'IDENTITY_PROMPT');

          // Handle DataChannel close after we are fully connected
          channel.onclose = () => {
            if (!isTransferringRef.current) {
              setConnectionState('DISCONNECTED');
              dataChannelRef.current = null;
            }
          };
        },

        onFailed: (stage, detail) => {
          if (!isCurrentAttempt()) return;
          setErrorMsg(detail);
          if (stage === 'SESSION_EXPIRED') {
            clearSessionData();
            setWorkflowState('SESSION_EXPIRED');
            setConnectionState('EXPIRED');
          } else if (stage === 'SESSION_NOT_FOUND') {
            clearSessionData();
            setWorkflowState('SESSION_NOT_FOUND');
            setConnectionState('EXPIRED');
          } else {
            setWorkflowState('INTERRUPTED');
            setConnectionState('DISCONNECTED');
          }
        },

        onSessionEnded: (reason) => {
          if (!isCurrentAttempt()) return;
          clearSessionData();
          setConnectionState('EXPIRED');
          setWorkflowState(reason === 'SESSION_EXPIRED' ? 'SESSION_EXPIRED' : 'SESSION_CLOSED');
        },
      },
    });

    // Stash signaling client for identity calls — will be set properly in onConnected
    // but we need the attempt object to call abort cleanly
    activeAttemptRef.current = attempt;
    attempt.start();
  }, []);

  // ─── Boot ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    // Ensure stable clientId for this browser tab
    let clientId = sessionStorage.getItem(SS.CLIENT_ID);
    if (!clientId) {
      clientId = crypto.randomUUID();
      sessionStorage.setItem(SS.CLIENT_ID, clientId);
    }

    const hash = window.location.hash.replace(/^#/, '').trim();
    const storedToken = sessionStorage.getItem(SS.TOKEN);
    const storedNumeric = sessionStorage.getItem(SS.NUMERIC);
    const storedCode = sessionStorage.getItem(SS.CODE);
    const storedBatch = sessionStorage.getItem(SS.BATCH);
    const storedName = sessionStorage.getItem(SS.NAME);

    if (storedCode) setCustomerCode(storedCode);
    if (storedBatch) setBatchId(storedBatch);
    if (storedName) setDisplayName(storedName);

    if (hash) {
      // Strip token from address bar for privacy
      try { window.history.replaceState(null, '', window.location.pathname); } catch {}
    }

    if (initialNumericCode) {
      // Permanent-QR bridge entry (§16): the /connect endpoint already routed us to the
      // shop's current session. Join by its numericCode (passed as both, matching the
      // manual-code path) — the server resolves it via getSessionByNumericCode.
      startNewAttempt(initialNumericCode, initialNumericCode);
    } else if (hash) {
      startNewAttempt(hash);
    } else if (storedToken) {
      // Reconnect after reload: reuse the numeric code so code-only sessions can rejoin.
      startNewAttempt(storedToken, storedNumeric ?? undefined);
    } else {
      setWorkflowState('IDLE');
      setConnectionState('IDLE');
    }

    return () => {
      // On unmount, abort any pending attempt
      activeAttemptRef.current?.abort('unmount');
      attemptIdRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNewAttempt]);

  // ─── Event handlers ─────────────────────────────────────────────────────────

  const handleRetry = useCallback(() => {
    const tok = tokenRef.current || token || manualCode.trim();
    if (tok) {
      startNewAttempt(tok, tok.length <= 10 ? tok : undefined);
    }
  }, [token, manualCode, startNewAttempt]);

  const handleResetToScanner = useCallback(() => {
    // Kill current attempt and invalidate all stale callbacks
    activeAttemptRef.current?.abort('user_rescan');
    activeAttemptRef.current = null;
    attemptIdRef.current++;
    activeSenderRef.current?.cancel('Customer restarted the session');
    activeSenderRef.current = null;
    signalingClientRef.current = null;
    dataChannelRef.current = null;
    isTransferringRef.current = false;

    tokenRef.current = '';
    setToken('');
    setWorkflowState('IDLE');
    setConnectionState('IDLE');
    setConnectionStage('IDLE');
    setErrorMsg(null);
    setIsScannerOpen(true);
  }, []);

  const handleResetToManualCode = useCallback(() => {
    activeAttemptRef.current?.abort('user_manual_code');
    activeAttemptRef.current = null;
    attemptIdRef.current++;
    activeSenderRef.current?.cancel('Customer restarted the session');
    activeSenderRef.current = null;
    isTransferringRef.current = false;
    signalingClientRef.current = null;
    dataChannelRef.current = null;

    tokenRef.current = '';
    setToken('');
    setWorkflowState('IDLE');
    setConnectionState('IDLE');
    setConnectionStage('IDLE');
    setErrorMsg(null);
    setIsScannerOpen(false);
  }, []);

  const handleManualCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    const cleanCode = manualCode.trim().toUpperCase();
    startNewAttempt(cleanCode, cleanCode);
  };

  const handleScanSuccess = (result: QrScanResult) => {
    setIsScannerOpen(false);
    if (result.kind === 'shop') {
      // A permanent shop QR routes through the resolve → connect bridge (§16), which then
      // re-hosts this page with the bridged numericCode.
      navigate(`/s/${result.publicShopId}`);
      return;
    }
    startNewAttempt(result.token);
  };

  const handleFilesSelected = (files: File[]) => {
    setSelectedFiles((prev) => [...prev, ...files]);
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleIdentitySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = displayName.trim().substring(0, 32);
    setDisplayName(cleanName);
    sessionStorage.setItem(SS.NAME, cleanName);
    signalingClientRef.current?.updateCustomer(cleanName || null);
    setWorkflowState('BATCH_VIEW');
  };

  const handleDoneSending = () => {
    setIsBatchCompleted(true);
    signalingClientRef.current?.batchCompleted();
  };

  const handleSendDocuments = async () => {
    if (selectedFiles.length === 0 || selectedFiles.length === transferProgresses.length) return;

    setErrorMsg(null);
    setWorkflowState('SENDING');
    setConnectionState('TRANSFERRING');
    isTransferringRef.current = true;

    const initialProgresses: TransferProgress[] = [...transferProgresses];
    const startIndex = transferProgresses.length;

    for (let i = startIndex; i < selectedFiles.length; i++) {
      initialProgresses[i] = {
        transferId: crypto.randomUUID(),
        fileName: selectedFiles[i].name,
        fileSize: selectedFiles[i].size,
        transferredBytes: 0,
        percentage: 0,
        speedBytesPerSec: 0,
        estimatedRemainingSec: 0,
        status: 'QUEUED',
      };
    }
    setTransferProgresses(initialProgresses);

    /** Never leave a file sitting in QUEUED: give it an explicit terminal row. */
    const markFailed = (index: number, file: File, error: string) => {
      setTransferProgresses((prev) => {
        const updated = [...prev];
        const existing = updated[index];
        updated[index] = {
          transferId: existing?.transferId ?? crypto.randomUUID(),
          fileName: file.name,
          fileSize: file.size,
          transferredBytes: existing?.transferredBytes ?? 0,
          percentage: existing?.percentage ?? 0,
          speedBytesPerSec: 0,
          estimatedRemainingSec: 0,
          status: 'FAILED',
          error,
        };
        return updated;
      });
    };

    let succeeded = 0;
    let failed = 0;

    try {
      for (let i = startIndex; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        // If the link itself is gone, no later file can succeed either — fail the
        // remainder explicitly rather than leaving them "Waiting in Queue".
        if (dataChannelRef.current?.readyState !== 'open') {
          markFailed(i, file, 'Connection to the shop was lost.');
          failed++;
          continue;
        }

        // Each file gets its own FileSender: its own transferId, listeners, timers
        // and buffers. Nothing is shared, so a failure cannot leak into the next.
        const sender = new FileSender(file, dataChannelRef.current, {
          onProgress: (progress) => {
            setTransferProgresses((prev) => {
              const updated = [...prev];
              updated[i] = progress;
              return updated;
            });
          },
          onError: (err) => {
            setErrorMsg(`${file.name}: ${err.message}`);
          },
        });
        activeSenderRef.current = sender;

        // start() resolves even when the transfer fails — that is deliberate, so
        // the batch always advances to the next file without user interaction.
        await sender.start();
        activeSenderRef.current = null;

        if (sender.wasCompleted) succeeded++;
        else failed++;
      }

      // A failed file must not tear down the session (the channel may be perfectly
      // healthy). Only an unusable connection counts as an interruption.
      if (succeeded === 0 && failed > 0 && dataChannelRef.current?.readyState !== 'open') {
        setWorkflowState('INTERRUPTED');
        setConnectionState('UNSTABLE');
      } else {
        setWorkflowState('COMPLETED');
        setConnectionState('COMPLETED');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Document transfer interrupted.');
      setWorkflowState('INTERRUPTED');
      setConnectionState('UNSTABLE');
    } finally {
      activeSenderRef.current = null;
      isTransferringRef.current = false;
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  const isReconnecting = workflowState === 'CONNECTING' &&
    !!sessionStorage.getItem(SS.TOKEN) &&
    sessionStorage.getItem(SS.TOKEN) === (token || tokenRef.current);

  // When entered via the permanent QR (§16) we know the shop's name; otherwise fall back
  // to the generic label used by the manual-code / legacy-token paths.
  const shopLabel = initialShopName?.trim() || 'Print Shop';

  return (
    <div className="min-h-screen bg-background pb-16">
      {/* In-Browser QR Camera Scanner Modal */}
      <QrScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        onScanSuccess={handleScanSuccess}
        onSwitchToManualCode={() => setIsScannerOpen(false)}
      />

      <main className="mx-auto max-w-lg px-4 pt-6 space-y-6">
        {/* Top Status Header */}
        <div className="flex items-center justify-between rounded-2xl bg-surface border border-surface-variant p-4 shadow-m3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-container text-primary">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-text-primary">Send to Shop</h1>
              <p className="text-xs text-text-secondary">Direct Encrypted Transfer</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(token || tokenRef.current || connectionState !== 'IDLE') && (
              <button
                onClick={handleResetToScanner}
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface-variant text-text-secondary hover:text-primary hover:bg-primary-container/40 transition-colors touch-target"
                title="Scan QR Code"
                aria-label="Scan QR Code"
              >
                <Camera className="h-4 w-4" />
              </button>
            )}
            <StatusIndicator state={connectionState} />
          </div>
        </div>

        {/* ── IDLE: Entry Landing ─────────────────────────────────────────────── */}
        {(workflowState === 'IDLE' || workflowState === 'INITIALIZING') && connectionState === 'IDLE' && (
          <div className="space-y-5 animate-in fade-in duration-200">
            <div className="rounded-3xl border border-surface-variant bg-surface p-6 shadow-m3 text-center space-y-5">
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-text-primary">Transfer to Shop</h2>
                <p className="text-xs text-text-secondary">
                  Scan the QR code displayed on the shop's screen to connect instantly.
                </p>
              </div>

              <button
                onClick={() => setIsScannerOpen(true)}
                className="w-full flex flex-col items-center justify-center gap-3.5 py-7 px-4 rounded-2xl bg-primary-container/40 hover:bg-primary-container/70 border-2 border-dashed border-primary/40 hover:border-primary text-primary transition-all btn-tactile group touch-target"
                aria-label="Open camera and scan shop QR code"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-white shadow-md group-hover:scale-105 transition-transform">
                  <Camera className="h-8 w-8" />
                </div>
                <div className="space-y-0.5">
                  <span className="text-base font-bold text-text-primary block">Scan Shop QR Code</span>
                  <span className="text-xs text-text-secondary block">Tap to open camera viewfinder</span>
                </div>
              </button>
            </div>

            <div className="relative flex items-center justify-center">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-surface-variant" />
              </div>
              <span className="relative bg-background px-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                OR
              </span>
            </div>

            <div className="rounded-2xl border border-surface-variant bg-surface p-5 shadow-sm space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-variant text-text-secondary">
                  <KeyRound className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-text-primary">Enter Backup Code</h3>
                  <p className="text-[11px] text-text-secondary">
                    Use the 6-character code below the QR on the shop's screen.
                  </p>
                </div>
              </div>

              <form onSubmit={handleManualCodeSubmit} className="space-y-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                    placeholder="e.g. GSTCCJ"
                    className="flex-1 text-center tracking-widest uppercase font-mono text-base py-3 rounded-xl border border-surface-variant bg-surface-variant/40 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary touch-target"
                    aria-label="Shop 6-character backup code"
                  />
                  <button
                    type="submit"
                    disabled={manualCode.length < 4}
                    className="flex items-center justify-center gap-1.5 rounded-xl bg-primary hover:bg-primary-hover text-white px-5 py-3 text-xs font-semibold transition-all btn-tactile shadow-sm disabled:opacity-50 touch-target"
                  >
                    <span>Connect</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </form>
            </div>

            <div className="rounded-2xl border border-surface-variant bg-surface p-4 text-center space-y-1 shadow-sm">
              <div className="flex items-center justify-center gap-1.5 text-xs font-semibold text-text-primary">
                <ShieldCheck className="h-4 w-4 text-success" />
                <span>Zero Account • Zero Cloud Storage</span>
              </div>
              <p className="text-[11px] text-text-secondary leading-relaxed max-w-xs mx-auto">
                Encrypted peer-to-peer connection. Files stream directly to the shop's browser tab.
              </p>
            </div>
          </div>
        )}

        {/* ── CONNECTING ──────────────────────────────────────────────────────── */}
        {workflowState === 'CONNECTING' && (
          <div className="rounded-2xl border border-surface-variant bg-surface p-8 shadow-m3 text-center space-y-5 animate-in fade-in duration-200">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-container text-primary mx-auto">
              <RefreshCw className="h-7 w-7 animate-spin" />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-text-primary">
                {isReconnecting ? 'Reconnecting to shop...' : 'Connecting to Shop Counter'}
              </h2>
              <p className="text-xs text-text-secondary">
                {STAGE_LABELS[connectionStage] || 'Securing direct connection to the shop...'}
              </p>
            </div>

            <div className="pt-2 border-t border-surface-variant flex flex-col gap-2">
              <button
                onClick={handleResetToScanner}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-surface-variant hover:bg-surface-variant/80 text-text-primary py-2.5 px-4 text-xs font-semibold transition-all touch-target"
              >
                <Camera className="h-4 w-4 text-primary" />
                <span>Scan Another QR Code</span>
              </button>
              <button
                onClick={handleResetToManualCode}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-transparent hover:bg-surface-variant/40 text-text-secondary py-2 px-4 text-xs font-medium transition-all touch-target"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Enter Backup Code Manually</span>
              </button>
            </div>
          </div>
        )}

        {/* ── IDENTITY_PROMPT ─────────────────────────────────────────────────── */}
        {workflowState === 'IDENTITY_PROMPT' && (
          <div className="rounded-3xl border border-surface-variant bg-surface p-6 shadow-m3 space-y-6 animate-in fade-in zoom-in-95 duration-200">
            <div className="text-center space-y-2">
              <h2 className="text-xl font-bold text-text-primary">Connected to {shopLabel}</h2>
              <p className="text-sm text-text-secondary">Your customer code is</p>
              <div className="inline-block bg-primary-container text-primary font-mono text-2xl font-bold tracking-widest px-6 py-2 rounded-xl mt-2">
                {customerCode}
              </div>
            </div>

            <form onSubmit={handleIdentitySubmit} className="space-y-6">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-primary text-center">
                  How should the shop identify you?
                </label>
                <input
                  type="text"
                  maxLength={32}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name (optional)"
                  className="w-full text-center text-base py-3 rounded-xl border border-surface-variant bg-surface-variant/40 text-text-primary focus:outline-none focus:ring-2 focus:ring-primary touch-target"
                />
              </div>

              <div className="rounded-xl border border-surface-variant bg-surface-variant/30 p-4 text-center">
                <p className="text-xs text-text-secondary mb-1">You'll appear as</p>
                <p className="font-semibold text-text-primary">
                  {displayName.trim() || 'Customer'}{' '}
                  <span className="text-text-muted font-normal">· {customerCode}</span>
                </p>
              </div>

              <button
                type="submit"
                className="w-full flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-4 text-sm font-semibold transition-all btn-tactile shadow-md touch-target"
              >
                <span>Continue</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            <p className="text-[11px] text-text-secondary text-center">No account required</p>
          </div>
        )}

        {/* ── BATCH_VIEW / SENDING / COMPLETED ────────────────────────────────── */}
        {(workflowState === 'BATCH_VIEW' || workflowState === 'SENDING' || workflowState === 'COMPLETED') && (
          <div className="space-y-5 animate-in fade-in duration-200">
            <div className="flex items-center justify-between text-xs text-text-secondary mb-2">
              <span>Connected to {shopLabel}</span>
              <span className="font-semibold text-text-primary">
                {displayName || 'Customer'}{' '}
                <span className="text-text-muted font-normal">
                  · {customerCode} {batchId && `(${batchId.slice(0, 4)})`}
                </span>
              </span>
            </div>

            <FilePicker
              onFilesSelected={handleFilesSelected}
              disabled={connectionState !== 'READY' && connectionState !== 'TRANSFERRING' && connectionState !== 'COMPLETED'}
            />

            {selectedFiles.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                      {selectedFiles.length} {selectedFiles.length === 1 ? 'document' : 'documents'}
                    </h3>
                    <p className="text-[10px] text-text-muted">
                      {(selectedFiles.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024)).toFixed(2)} MB total
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  {selectedFiles.map((file, idx) => {
                    const progress = transferProgresses[idx];
                    if (progress) {
                      return <TransferProgressCard key={`${progress.transferId}-${idx}`} progress={progress} />;
                    }
                    return (
                      <FileItemCard
                        key={`${file.name}-${idx}`}
                        file={file}
                        onRemove={() => handleRemoveFile(idx)}
                      />
                    );
                  })}
                </div>

                {!isBatchCompleted ? (
                  <div className="space-y-3 pt-4">
                    {selectedFiles.length > transferProgresses.length && (
                      <button
                        onClick={handleSendDocuments}
                        disabled={connectionState !== 'READY' && connectionState !== 'TRANSFERRING' && connectionState !== 'COMPLETED'}
                        className="w-full flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-4 text-sm font-semibold transition-all btn-tactile shadow-md disabled:opacity-50 touch-target"
                      >
                        <Send className="h-4 w-4" />
                        <span>SEND ALL</span>
                      </button>
                    )}

                    <button
                      onClick={handleDoneSending}
                      className="w-full rounded-pill border border-surface-variant bg-surface hover:bg-surface-variant/50 text-text-primary py-4 text-sm font-semibold transition-all btn-tactile touch-target"
                    >
                      Done Sending
                    </button>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-success/30 bg-success-container/30 p-6 text-center space-y-2 mt-4">
                    <div className="flex justify-center">
                      <CheckCircle2 className="h-8 w-8 text-success" />
                    </div>
                    <h3 className="font-bold text-text-primary text-sm">Batch Complete</h3>
                    <p className="text-xs text-text-secondary">
                      You have finished sending files for this batch. You can close this page.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── INTERRUPTED ─────────────────────────────────────────────────────── */}
        {workflowState === 'INTERRUPTED' && (
          <div className="rounded-2xl border border-error/30 bg-surface p-6 shadow-m3 space-y-4 text-center animate-in fade-in duration-200">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-error-container text-error mx-auto">
              <AlertCircle className="h-6 w-6" />
            </div>

            <div className="space-y-1">
              <h2 className="text-base font-bold text-text-primary">Couldn't Connect to Shop</h2>
              <p className="text-xs text-text-secondary leading-relaxed">
                {errorMsg || 'Connection could not be established.'}
              </p>
            </div>

            <div className="rounded-xl bg-surface-variant/60 p-3 text-xs text-text-secondary">
              📱 <strong>Your original file is still safe on your phone.</strong>
            </div>

            <div className="space-y-2 pt-1">
              <button
                onClick={handleRetry}
                className="w-full flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-3.5 text-sm font-semibold transition-all btn-tactile shadow-sm touch-target"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Retry Connection</span>
              </button>
              <button
                onClick={handleResetToScanner}
                className="w-full flex items-center justify-center gap-2 rounded-pill bg-surface-variant hover:bg-surface-variant/80 text-text-primary py-3 text-xs font-semibold transition-all touch-target"
              >
                <Camera className="h-3.5 w-3.5" />
                <span>Scan New QR Code</span>
              </button>
              <button
                onClick={handleResetToManualCode}
                className="w-full flex items-center justify-center gap-2 rounded-pill bg-transparent hover:bg-surface-variant/40 text-text-secondary py-2 text-xs font-medium transition-all touch-target"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Enter Backup Code</span>
              </button>
            </div>
          </div>
        )}

        {/* ── SESSION_EXPIRED ──────────────────────────────────────────────────── */}
        {(workflowState === 'SESSION_EXPIRED' || workflowState === 'SESSION_NOT_FOUND') && (
          <div className="rounded-2xl border border-surface-variant bg-surface p-6 shadow-m3 space-y-4 text-center animate-in fade-in duration-200">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-error-container text-error mx-auto">
              <Clock className="h-6 w-6" />
            </div>

            <div className="space-y-1">
              <h2 className="text-base font-bold text-text-primary">
                {workflowState === 'SESSION_EXPIRED' ? 'Session Expired' : 'Session Not Found'}
              </h2>
              <p className="text-xs text-text-secondary leading-relaxed">
                {workflowState === 'SESSION_EXPIRED'
                  ? 'This transfer session has expired for your privacy. Please scan the latest QR code at the shop counter.'
                  : 'This session no longer exists. Please scan the latest QR code at the shop counter.'}
              </p>
            </div>

            <div className="space-y-2 pt-2">
              <button
                onClick={handleResetToScanner}
                className="w-full inline-flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-3.5 text-sm font-semibold transition-all btn-tactile shadow-sm touch-target"
              >
                <Camera className="h-4 w-4" />
                <span>Scan QR Again</span>
              </button>
              <button
                onClick={handleResetToManualCode}
                className="w-full inline-flex items-center justify-center gap-2 rounded-pill bg-surface-variant hover:bg-surface-variant/80 text-text-primary py-3 text-xs font-semibold transition-all touch-target"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Enter Backup Code</span>
              </button>
            </div>
          </div>
        )}

        {/* ── SESSION_CLOSED ───────────────────────────────────────────────────── */}
        {workflowState === 'SESSION_CLOSED' && (
          <div className="rounded-2xl border border-surface-variant bg-surface p-6 shadow-m3 space-y-4 text-center animate-in fade-in duration-200">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-variant text-text-secondary mx-auto">
              <Clock className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-bold text-text-primary">Session Closed</h2>
              <p className="text-xs text-text-secondary leading-relaxed">
                The shop has ended this session. Please scan the QR code again to start a new session.
              </p>
            </div>
            <button
              onClick={handleResetToScanner}
              className="w-full inline-flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-3.5 text-sm font-semibold transition-all btn-tactile shadow-sm touch-target"
            >
              <Camera className="h-4 w-4" />
              <span>Scan QR Again</span>
            </button>
          </div>
        )}
      </main>
    </div>
  );
};
