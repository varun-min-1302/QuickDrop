import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CreateSessionResponse, IceServerConfig, ShopSummary } from '@quickdrop/shared';
import { SignalingClient } from '../lib/webrtc/signalingClient.js';
import { useShopPeers } from '../lib/webrtc/useShopPeers.js';
import { groupDashboard, removeDocument } from '../lib/webrtc/shopDashboardState.js';
import type { BatchStatus } from '../lib/webrtc/ShopPeerManager.js';
import { StatusIndicator, AppConnectionState } from '../components/StatusIndicator.js';
import { QrCodeCard } from '../components/QrCodeCard.js';
import { TransferProgressCard } from '../components/TransferProgressCard.js';
import { ReceivedFileCard } from '../components/ReceivedFileCard.js';
import { ApiError } from '../lib/api/http.js';
import { listShops } from '../lib/api/shops.js';
import {
  claimDashboard,
  heartbeatDashboard,
  releaseDashboard,
  openShopSession,
  type DashboardActiveDevice,
} from '../lib/api/dashboard.js';
import {
  HEARTBEAT_INTERVAL_MS,
  TRANSFER_SESSION_TTL_SECONDS,
  describeActiveDevice,
} from '../lib/dashboard/dashboardPolicy.js';
import { buildShopQrUrl } from '../lib/qr/shopQr.js';
import {
  ShieldCheck,
  Inbox,
  RefreshCw,
  AlertCircle,
  Users,
  Loader2,
  Settings,
  MonitorSmartphone,
  LogIn,
  ArrowRight,
} from 'lucide-react';

export type ShopWorkflowState =
  | 'NO_SESSION'
  | 'WAITING_FOR_SCAN'
  | 'CUSTOMER_CONNECTED'
  | 'TRANSFERRING'
  | 'SESSION_EXPIRED';

/**
 * Dashboard-device lifecycle phase (spec §11/§12/§15), distinct from the transfer
 * `connectionState` which continues to describe the ephemeral WebRTC layer.
 */
type DashboardPhase = 'RESOLVING' | 'NO_SHOP' | 'CONFLICT' | 'ACTIVE' | 'REVOKED' | 'ERROR';

/** Same-tab reuse of an already-claimed device, so a refresh doesn't self-conflict (§11). */
const DASHBOARD_DEVICE_STORAGE_KEY = 'quickdrop_dashboard_device';

/** Operator-facing wording for a customer's batch lifecycle. */
const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  EMPTY: 'No Documents',
  RECEIVING: 'Receiving',
  READY_TO_PRINT: 'Ready to Print',
  COMPLETED: 'Batch Complete',
};

const BATCH_STATUS_STYLE: Record<BatchStatus, string> = {
  EMPTY: 'bg-surface-variant text-text-muted',
  RECEIVING: 'bg-warning-container text-warning',
  READY_TO_PRINT: 'bg-success-container text-success',
  COMPLETED: 'bg-primary-container text-primary',
};

/**
 * Short human-quotable batch reference (e.g. `A82F`). The full batchId stays the
 * durable key everywhere in code; this is only ever shown, never matched on.
 */
function formatBatchRef(batchId: string): string {
  const tail = batchId.replace(/[^a-zA-Z0-9]/g, '').slice(-4);
  return (tail || batchId).toUpperCase();
}

function readStoredDeviceSessionId(publicShopId: string): string | null {
  try {
    const raw = sessionStorage.getItem(DASHBOARD_DEVICE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { publicShopId?: string; deviceSessionId?: string };
    if (parsed.publicShopId === publicShopId && typeof parsed.deviceSessionId === 'string') {
      return parsed.deviceSessionId;
    }
  } catch {
    /* malformed — ignore and re-claim */
  }
  return null;
}
function writeStoredDeviceSessionId(publicShopId: string, deviceSessionId: string): void {
  try {
    sessionStorage.setItem(
      DASHBOARD_DEVICE_STORAGE_KEY,
      JSON.stringify({ publicShopId, deviceSessionId })
    );
  } catch {
    /* storage unavailable — reuse-on-refresh simply won't apply */
  }
}
function clearStoredDeviceSessionId(): void {
  try {
    sessionStorage.removeItem(DASHBOARD_DEVICE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Shop dashboard (spec §11–§16). Rendered behind {@link RequireAuth}. It resolves the
 * signed-in owner's permanent shop, claims the ONE active dashboard device (with a
 * [Take Over] path on conflict), heartbeats to keep the shop online, and opens an
 * authenticated shop-scoped transfer session that it JOINs as `shop`.
 *
 * The WebRTC / file-transfer path is deliberately untouched: {@link useShopPeers}, the
 * {@link SignalingClient} JOIN-as-shop, and the customers/transfers/received-docs UI behave
 * exactly as before. Only the session's ORIGIN moved from the anonymous `POST /api/sessions`
 * to the shop-linked bridge, and the on-screen QR now encodes the PERMANENT `/s/:publicShopId`
 * URL (never a token) so it matches the printed poster and survives session rotation.
 */
export const ShopDashboardPage: React.FC = () => {
  const [phase, setPhase] = useState<DashboardPhase>('RESOLVING');
  const [shop, setShop] = useState<ShopSummary | null>(null);
  const [activeDevice, setActiveDevice] = useState<DashboardActiveDevice | null>(null);
  const [authExpired, setAuthExpired] = useState(false);

  const [session, setSession] = useState<CreateSessionResponse | null>(null);
  const [connectionState, setConnectionState] = useState<AppConnectionState>('IDLE');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [signalingClient, setSignalingClient] = useState<SignalingClient | null>(null);
  const [iceServers, setIceServers] = useState<IceServerConfig[]>([]);

  const { customers, transfers, receivedDocs, setReceivedDocs } = useShopPeers(signalingClient, iceServers);

  /**
   * Durable per-customer grouping. Derived, never stored: customers/receivedDocs are
   * each merged one fact at a time, so a new customer can't disturb another's group and
   * a document can't lose the identity it was stamped with on receipt.
   */
  const { groups: customerGroups, orphans: orphanDocs } = useMemo(
    () => groupDashboard(customers, receivedDocs, transfers),
    [customers, receivedDocs, transfers]
  );

  // Refs keep the lifecycle callbacks stable and free of stale closures. `signalingRef`
  // mirrors the client state so cleanup can close it without depending on render scope.
  const docsRef = useRef(receivedDocs);
  const mountedRef = useRef(true);
  const publicShopIdRef = useRef<string | null>(null);
  const deviceSessionIdRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const renewingRef = useRef(false);
  const signalingRef = useRef<SignalingClient | null>(null);
  const renewRef = useRef<() => void>(() => {});

  useEffect(() => {
    docsRef.current = receivedDocs;
  }, [receivedDocs]);

  const cleanupConnections = useCallback(() => {
    if (signalingRef.current) {
      signalingRef.current.close();
      signalingRef.current = null;
    }
    setSignalingClient(null);
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== null) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  // This device lost the dashboard (taken over elsewhere). Stop everything and prompt reclaim.
  const handleRevoked = useCallback(() => {
    stopHeartbeat();
    cleanupConnections();
    clearStoredDeviceSessionId();
    deviceSessionIdRef.current = null;
    setSession(null);
    setConnectionState('DISCONNECTED');
    setPhase('REVOKED');
  }, [stopHeartbeat, cleanupConnections]);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatTimerRef.current = window.setInterval(async () => {
      const pid = publicShopIdRef.current;
      const dsid = deviceSessionIdRef.current;
      if (!pid || !dsid) return;
      try {
        const beat = await heartbeatDashboard(pid, dsid);
        if (beat.kind === 'revoked' && mountedRef.current) handleRevoked();
      } catch {
        // Transient network/proxy error — keep the interval running and retry next tick.
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, [stopHeartbeat, handleRevoked]);

  // Attach the WebRTC signaling layer to a transfer session and JOIN as `shop`.
  // NOTE: this preserves the existing signaling contract exactly — the only behavioural
  // change is that session expiry/closure now transparently rotates to a fresh session
  // (the permanent QR must keep working) instead of dead-ending in SESSION_EXPIRED.
  const attachToSession = useCallback(async (sessionData: CreateSessionResponse) => {
    cleanupConnections();
    setErrorMsg(null);
    setConnectionState('INITIALIZING');
    setSession(sessionData);

    try {
      const signaling = new SignalingClient();
      signalingRef.current = signaling;
      setSignalingClient(signaling);

      signaling.on('join_accepted', (accepted) => {
        setIceServers(accepted.iceServers);
        setErrorMsg(null);
        setConnectionState('READY');
      });

      signaling.on('session_expired', () => {
        // Permanent QR stays valid: rotate to a fresh transfer session rather than expiring.
        renewRef.current();
      });

      signaling.on('session_closed', () => {
        renewRef.current();
      });

      signaling.on('connection_state_change', (sigState) => {
        if (sigState === 'RECONNECTING') {
          setConnectionState('CONNECTING');
        } else if (sigState === 'CONNECTED') {
          setErrorMsg(null);
          setConnectionState('READY');
        }
      });

      signaling.on('error', (err) => {
        setErrorMsg(err.message);
      });

      await signaling.connect();

      signaling.join({
        role: 'shop',
        token: sessionData.joinToken,
        sessionId: sessionData.sessionId,
      });
    } catch (err: unknown) {
      console.error('Session attachment failed:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Could not connect to QuickDrop server.');
      setConnectionState('DISCONNECTED');
    }
  }, [cleanupConnections]);

  // Open a shop-scoped transfer session (bridge) and attach WebRTC. Guarded so overlapping
  // expiry/timer triggers can't spawn duplicate sessions.
  const openAndAttachSession = useCallback(async () => {
    const pid = publicShopIdRef.current;
    if (!pid || renewingRef.current) return;
    renewingRef.current = true;
    setBusy(true);
    try {
      const created = await openShopSession(pid, TRANSFER_SESSION_TTL_SECONDS);
      if (!mountedRef.current) return;
      await attachToSession(created);
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(err instanceof ApiError ? err.message : 'Could not start a transfer session.');
      setConnectionState('DISCONNECTED');
    } finally {
      renewingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [attachToSession]);

  // Keep the signaling-handler renew hook pointed at the latest opener (avoids stale closures).
  useEffect(() => {
    renewRef.current = () => {
      void openAndAttachSession();
    };
  }, [openAndAttachSession]);

  const beginDashboard = useCallback(
    async (publicShopId: string, deviceSessionId: string) => {
      deviceSessionIdRef.current = deviceSessionId;
      publicShopIdRef.current = publicShopId;
      writeStoredDeviceSessionId(publicShopId, deviceSessionId);
      setActiveDevice(null);
      setPhase('ACTIVE');
      startHeartbeat();
      await openAndAttachSession();
    },
    [startHeartbeat, openAndAttachSession]
  );

  const resolveAndClaim = useCallback(async () => {
    setPhase('RESOLVING');
    setErrorMsg(null);
    setAuthExpired(false);
    try {
      const shops = await listShops();
      if (!mountedRef.current) return;
      const owned = shops[0] ?? null;
      if (!owned) {
        setPhase('NO_SHOP');
        return;
      }
      setShop(owned);
      publicShopIdRef.current = owned.publicShopId;

      // Refresh-safe: if this tab already held the dashboard, resume it instead of
      // colliding with our own still-fresh device record.
      const stored = readStoredDeviceSessionId(owned.publicShopId);
      if (stored) {
        const beat = await heartbeatDashboard(owned.publicShopId, stored).catch(() => null);
        if (!mountedRef.current) return;
        if (beat && beat.kind === 'ok') {
          await beginDashboard(owned.publicShopId, stored);
          return;
        }
        clearStoredDeviceSessionId();
      }

      const claim = await claimDashboard(owned.publicShopId, { takeOver: false });
      if (!mountedRef.current) return;
      if (claim.kind === 'conflict') {
        setActiveDevice(claim.activeDevice);
        setPhase('CONFLICT');
        return;
      }
      await beginDashboard(owned.publicShopId, claim.deviceSessionId);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) {
        setAuthExpired(true);
        setErrorMsg('Your session has expired. Please sign in again.');
      } else {
        setErrorMsg(err instanceof ApiError ? err.message : 'Could not load your shop dashboard.');
      }
      setPhase('ERROR');
    }
  }, [beginDashboard]);

  const takeOver = useCallback(async () => {
    const pid = publicShopIdRef.current ?? shop?.publicShopId;
    if (!pid) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const claim = await claimDashboard(pid, { takeOver: true });
      if (!mountedRef.current) return;
      if (claim.kind === 'conflict') {
        // Extraordinarily rare race: someone else grabbed it in the same instant.
        setActiveDevice(claim.activeDevice);
        setPhase('CONFLICT');
        return;
      }
      await beginDashboard(pid, claim.deviceSessionId);
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(err instanceof ApiError ? err.message : 'Could not take over the dashboard.');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [shop, beginDashboard]);

  const releaseAndCleanup = useCallback(async () => {
    const pid = publicShopIdRef.current;
    const dsid = deviceSessionIdRef.current;
    cleanupConnections();
    if (pid && dsid) {
      try {
        await releaseDashboard(pid, dsid);
      } catch {
        // Best-effort — the device also expires on its own once heartbeats stop.
      }
      clearStoredDeviceSessionId();
      deviceSessionIdRef.current = null;
    }
  }, [cleanupConnections]);

  useEffect(() => {
    mountedRef.current = true;
    void resolveAndClaim();
    return () => {
      mountedRef.current = false;
      stopHeartbeat();
      void releaseAndCleanup();
      docsRef.current.forEach((doc) => URL.revokeObjectURL(doc.objectUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeleteReceivedDoc = (documentId: string) => {
    setReceivedDocs((prev) => {
      const doc = prev.find((d) => d.documentId === documentId);
      if (doc) URL.revokeObjectURL(doc.objectUrl);
      return removeDocument(prev, documentId);
    });
  };

  // The on-screen QR encodes the PERMANENT customer-entry URL (publicShopId only) — the same
  // value as the printed poster, never a token or session id (spec §14/§E).
  const getCustomerJoinUrl = () => {
    if (!shop) return '';
    const origin = (import.meta as { env?: { VITE_PUBLIC_APP_URL?: string } }).env?.VITE_PUBLIC_APP_URL || window.location.origin;
    return buildShopQrUrl(origin, shop.publicShopId);
  };

  // ---- Non-active phases: full-screen status cards -------------------------------------

  if (phase === 'RESOLVING') {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-text-secondary">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-xs">Preparing your dashboard…</p>
      </div>
    );
  }

  if (phase === 'NO_SHOP') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary-container text-primary">
          <Settings className="h-7 w-7" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-text-primary">Set up your shop first</h1>
          <p className="text-xs text-text-secondary">
            You need a permanent shop identity before you can open the dashboard.
          </p>
        </div>
        <Link
          to="/shop/setup"
          className="inline-flex items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile shadow-sm touch-target"
        >
          <span>Go to shop setup</span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  if (phase === 'CONFLICT') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning/15 text-warning">
          <MonitorSmartphone className="h-7 w-7" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-text-primary">Dashboard is open elsewhere</h1>
          <p className="text-xs text-text-secondary">
            This shop’s dashboard is already running on another device. Only one device can be
            the active dashboard at a time.
          </p>
          {activeDevice && (
            <p className="text-[11px] text-text-muted pt-1">
              {describeActiveDevice(activeDevice, Date.now())}
            </p>
          )}
        </div>
        {errorMsg && <p className="text-xs font-medium text-error">{errorMsg}</p>}
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={takeOver}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile shadow-sm disabled:opacity-50 touch-target"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MonitorSmartphone className="h-4 w-4" />}
            <span>Take over this dashboard</span>
          </button>
          <Link to="/shop/setup" className="text-xs text-text-secondary hover:text-primary">
            Back to shop settings
          </Link>
        </div>
      </div>
    );
  }

  if (phase === 'REVOKED') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-error-container text-error">
          <MonitorSmartphone className="h-7 w-7" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-text-primary">Dashboard taken over</h1>
          <p className="text-xs text-text-secondary">
            This shop’s dashboard was opened on another device, so this one stopped. You can
            reclaim it here — that will stop the other device.
          </p>
        </div>
        {errorMsg && <p className="text-xs font-medium text-error">{errorMsg}</p>}
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={takeOver}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile shadow-sm disabled:opacity-50 touch-target"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span>Reclaim dashboard</span>
          </button>
          <Link to="/shop/setup" className="text-xs text-text-secondary hover:text-primary">
            Back to shop settings
          </Link>
        </div>
      </div>
    );
  }

  if (phase === 'ERROR') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-error-container text-error">
          <AlertCircle className="h-7 w-7" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold text-text-primary">Couldn’t open the dashboard</h1>
          <p className="text-xs text-text-secondary">{errorMsg || 'Something went wrong.'}</p>
        </div>
        <div className="flex flex-col items-center gap-2">
          {authExpired ? (
            <Link
              to="/login"
              className="inline-flex items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile shadow-sm touch-target"
            >
              <LogIn className="h-4 w-4" />
              <span>Sign in again</span>
            </Link>
          ) : (
            <button
              onClick={resolveAndClaim}
              className="inline-flex items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile shadow-sm touch-target"
            >
              <RefreshCw className="h-4 w-4" />
              <span>Try again</span>
            </button>
          )}
          <Link to="/shop/setup" className="text-xs text-text-secondary hover:text-primary">
            Back to shop settings
          </Link>
        </div>
      </div>
    );
  }

  // ---- ACTIVE: this device is the shop's live dashboard --------------------------------

  return (
    <div className="min-h-screen bg-background pb-16">
      {/* Subheader / Status Bar */}
      <div className="border-b border-surface-variant bg-surface px-4 sm:px-8 py-3 transition-colors">
        <div className="mx-auto flex max-w-5xl items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold text-text-primary">{shop?.name || 'Shop Print Counter'}</h1>
            <StatusIndicator state={connectionState} />
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-pill bg-success/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              Active dashboard
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void openAndAttachSession()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary hover:bg-primary-hover text-white px-4 py-2 text-xs font-medium transition-all btn-tactile shadow-sm disabled:opacity-50 touch-target"
              title="Rotate the backup code / transfer session"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
              <span>New Code</span>
            </button>
            <Link
              to="/shop/setup"
              className="inline-flex items-center gap-1.5 rounded-pill bg-surface-variant hover:text-primary text-text-secondary px-3.5 py-2 text-xs font-medium border border-surface-variant transition-all btn-tactile touch-target"
            >
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Settings</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="mx-auto max-w-5xl px-4 sm:px-8 pt-6 space-y-6">
        {errorMsg && connectionState !== 'READY' && (
          <div className="flex items-center gap-2.5 rounded-2xl bg-error-container p-4 text-xs font-medium text-error shadow-sm">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: QR Code & Session Info */}
          <div className="lg:col-span-5 flex flex-col items-center space-y-4">
            {session ? (
              <QrCodeCard
                joinUrl={getCustomerJoinUrl()}
                numericCode={session.numericCode}
                expiresAt={session.expiresAt}
                onExpire={() => renewRef.current()}
              />
            ) : (
              <div className="flex flex-col items-center justify-center rounded-2xl bg-surface border border-surface-variant p-8 shadow-m3 w-full text-center space-y-4 min-h-[280px]">
                <Loader2 className="h-8 w-8 text-primary animate-spin" />
                <div className="space-y-1">
                  <h3 className="font-semibold text-text-primary text-base">Starting transfer session…</h3>
                  <p className="text-xs text-text-secondary">
                    Your permanent QR is ready — connecting customers to a fresh session.
                  </p>
                </div>
              </div>
            )}

            {/* Privacy Assurance Box */}
            <div className="rounded-2xl border border-surface-variant bg-surface-variant/30 p-4 text-xs text-text-secondary w-full max-w-sm space-y-1.5">
              <div className="flex items-center gap-2 font-semibold text-text-primary">
                <ShieldCheck className="h-4 w-4 text-success" />
                <span>Zero Cloud Storage Architecture</span>
              </div>
              <p className="text-[11px] leading-relaxed">
                Documents stream directly from the customer’s phone into this browser tab via peer-to-peer WebRTC. No files are saved to any server.
              </p>
            </div>
          </div>

          {/* Right Column: Connected Customers & Transfers */}
          <div className="lg:col-span-7 space-y-6">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
              <Users className="h-4 w-4" />
              <span>Customers ({customerGroups.length})</span>
            </h3>

            {customerGroups.length === 0 && orphanDocs.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-surface-variant bg-surface/50 p-12 text-center space-y-3 min-h-[220px]">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-variant text-text-muted">
                  <Inbox className="h-6 w-6" />
                </div>
                <div className="space-y-1 max-w-xs">
                  <p className="text-sm font-semibold text-text-primary">Waiting for Customers</p>
                  <p className="text-xs text-text-secondary">
                    Customers who scan the QR code will appear here along with their documents.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {customerGroups.map(({ customer: c, documents: custDocs, transfers: custTransfers, documentCount }) => {
                  const inFlight = custTransfers.filter((p) => p.status !== 'COMPLETED');
                  return (
                    <div key={c.clientId} className="space-y-3 p-4 rounded-2xl bg-surface border border-surface-variant shadow-sm animate-in fade-in duration-200">
                      <div className="flex items-start justify-between gap-3 pb-2 border-b border-surface-variant">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.connectionState === 'CONNECTED' ? 'bg-success' : c.connectionState === 'DISCONNECTED' ? 'bg-text-muted' : 'bg-warning animate-pulse'}`} />
                            <h4 className="truncate font-semibold text-text-primary text-sm">
                              {c.displayName || 'Customer'} <span className="text-text-muted font-normal">· {c.customerCode}</span>
                            </h4>
                          </div>
                          {/* Durable identity line: the customer, their batch and how much
                              they have sent — none of which may change because someone
                              else joined or this customer's phone briefly dropped. */}
                          <p className="pl-[18px] text-[11px] text-text-secondary">
                            {documentCount} {documentCount === 1 ? 'document' : 'documents'}
                            <span className="text-text-muted"> · Batch #{formatBatchRef(c.batchId)}</span>
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className={`rounded-pill px-2 py-0.5 text-[10px] font-bold uppercase ${BATCH_STATUS_STYLE[c.batchStatus]}`}>
                            {BATCH_STATUS_LABEL[c.batchStatus]}
                          </span>
                          <span className="text-[10px] uppercase font-bold text-text-muted">{c.connectionState}</span>
                        </div>
                      </div>

                      {inFlight.length > 0 && (
                        <div className="space-y-2">
                          <h5 className="text-[10px] uppercase font-bold text-text-muted tracking-wider">Receiving</h5>
                          {inFlight.map((progress) => (
                            <TransferProgressCard key={progress.transferId} progress={progress} />
                          ))}
                        </div>
                      )}

                      {custDocs.length > 0 && (
                        <div className="space-y-2 pt-1">
                          <h5 className="text-[10px] uppercase font-bold text-text-muted tracking-wider">Completed</h5>
                          {custDocs.map((doc) => (
                            <ReceivedFileCard
                              key={doc.documentId}
                              document={doc}
                              onDelete={handleDeleteReceivedDoc}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/*
              Documents whose customer is not in the projection. With clientId as the
              durable key and customers never removed on disconnect this should stay
              empty — but a document must never become unattributable, so if one does
              land here it is still shown under its OWN customer's name and code
              rather than in an anonymous "Previous Customers" pile.
            */}
            {orphanDocs.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  Earlier documents
                </h3>
                {orphanDocs.map((doc) => (
                  <div key={doc.documentId} className="space-y-1.5">
                    <p className="pl-1 text-[11px] font-medium text-text-secondary">
                      {doc.displayName || 'Customer'}
                      <span className="text-text-muted font-normal"> · {doc.customerCode} · Batch #{formatBatchRef(doc.batchId)}</span>
                    </p>
                    <ReceivedFileCard document={doc} onDelete={handleDeleteReceivedDoc} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
