import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { PublicShopConnectResponse } from '@quickdrop/shared';
import {
  Store, RefreshCw, WifiOff, Clock, AlertCircle, KeyRound, ShieldCheck,
} from 'lucide-react';
import { resolvePublicShop, connectPublicShop } from '../lib/api/publicShop.js';
import { ApiError } from '../lib/api/http.js';
import { isValidPublicShopId } from '../lib/qr/shopQr.js';
import { CustomerTransferPage } from './CustomerTransferPage.js';

/**
 * Customer entry point for a scanned PERMANENT shop QR (spec §14/§16), route
 * `/s/:publicShopId`. The QR encodes only the permanent `publicShopId` — never a token or
 * session — so this page:
 *
 *   1. resolves the shop (GET /api/public/shops/:publicShopId) to show its name + confirm
 *      it exists and is online, then
 *   2. bridges to the shop's CURRENT temporary transfer session
 *      (POST /api/public/shops/:publicShopId/connect), receiving that session's
 *      numericCode, and finally
 *   3. re-hosts the unchanged {@link CustomerTransferPage} with that numericCode, which
 *      performs the existing WebRTC customer join. This page adds NOTHING to the transfer
 *      path itself — it only turns a permanent identity into a live session.
 *
 * The permanent QR never expires: if the shop is offline or between sessions the customer
 * sees a friendly, retryable state rather than a dead end.
 */

type EntryPhase =
  | 'RESOLVING'
  | 'CONNECTING'
  | 'READY'
  | 'OFFLINE'
  | 'NOT_READY'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'ERROR';

export const ShopEntryPage: React.FC = () => {
  const { publicShopId: rawParam } = useParams<{ publicShopId: string }>();
  const publicShopId = (rawParam ?? '').trim().toUpperCase();

  const [phase, setPhase] = useState<EntryPhase>('RESOLVING');
  const [shopName, setShopName] = useState<string>('');
  const [session, setSession] = useState<PublicShopConnectResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();

    const friendly = (err: unknown): string =>
      err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';

    async function run() {
      if (!isValidPublicShopId(publicShopId)) {
        setPhase('INVALID');
        return;
      }

      setPhase('RESOLVING');
      setErrorMsg(null);

      // 1. Resolve the shop (name + online) and confirm the code exists.
      let online = false;
      try {
        const resolved = await resolvePublicShop(publicShopId, controller.signal);
        if (!mountedRef.current) return;
        setShopName(resolved.name);
        online = resolved.online;
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (err instanceof ApiError && err.status === 404) return setPhase('NOT_FOUND');
        if (err instanceof ApiError && err.status === 400) return setPhase('INVALID');
        setErrorMsg(friendly(err));
        return setPhase('ERROR');
      }

      if (!online) {
        setPhase('OFFLINE');
        return;
      }

      // 2. Bridge to the shop's current transfer session.
      setPhase('CONNECTING');
      try {
        const result = await connectPublicShop(publicShopId, controller.signal);
        if (!mountedRef.current) return;
        if (result.kind === 'offline') return setPhase('OFFLINE');
        if (result.kind === 'not_ready') return setPhase('NOT_READY');
        setSession(result.session);
        setPhase('READY');
      } catch (err) {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (err instanceof ApiError && err.status === 404) return setPhase('NOT_FOUND');
        setErrorMsg(friendly(err));
        setPhase('ERROR');
      }
    }

    void run();

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [publicShopId, attempt]);

  // ── Success: hand off to the unchanged customer transfer experience ──────────
  if (phase === 'READY' && session) {
    return <CustomerTransferPage initialNumericCode={session.numericCode} initialShopName={session.name} />;
  }

  const retry = () => setAttempt((n) => n + 1);

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      {(phase === 'RESOLVING' || phase === 'CONNECTING') && (
        <div className="rounded-2xl border border-surface-variant bg-surface p-8 shadow-m3 text-center space-y-5 animate-in fade-in duration-200">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-container text-primary mx-auto">
            <RefreshCw className="h-7 w-7 animate-spin" />
          </div>
          <div className="space-y-1">
            <h1 className="text-base font-semibold text-text-primary">
              {phase === 'RESOLVING' ? 'Finding the shop…' : `Connecting to ${shopName || 'the shop'}…`}
            </h1>
            <p className="text-xs text-text-secondary">
              {phase === 'RESOLVING'
                ? 'Looking up the shop from its QR code.'
                : 'Routing you to the shop’s current transfer session.'}
            </p>
          </div>
        </div>
      )}

      {phase === 'OFFLINE' && (
        <StatusCard
          icon={<WifiOff className="h-6 w-6" />}
          tone="muted"
          title={`${shopName || 'This shop'} is not open`}
          body="The shop isn’t accepting transfers right now. Please ask the counter to open their dashboard, then try again."
          onRetry={retry}
        />
      )}

      {phase === 'NOT_READY' && (
        <StatusCard
          icon={<Clock className="h-6 w-6" />}
          tone="muted"
          title={`${shopName || 'This shop'} isn’t ready yet`}
          body="The shop is open but hasn’t started a transfer session. Please wait a moment and try again."
          onRetry={retry}
        />
      )}

      {phase === 'NOT_FOUND' && (
        <StatusCard
          icon={<Store className="h-6 w-6" />}
          tone="error"
          title="Shop not found"
          body="This QR code doesn’t match an active QuickDrop shop. Double-check you scanned the shop’s QR, or enter the 6-character backup code."
        />
      )}

      {phase === 'INVALID' && (
        <StatusCard
          icon={<AlertCircle className="h-6 w-6" />}
          tone="error"
          title="Invalid shop code"
          body="That link isn’t a valid QuickDrop shop QR. Please scan the QR at the shop counter, or enter the 6-character backup code."
        />
      )}

      {phase === 'ERROR' && (
        <StatusCard
          icon={<AlertCircle className="h-6 w-6" />}
          tone="error"
          title="Couldn’t reach the shop"
          body={errorMsg || 'Something went wrong. Please try again.'}
          onRetry={retry}
        />
      )}
    </div>
  );
};

// ─── Presentational status card ────────────────────────────────────────────────

interface StatusCardProps {
  icon: React.ReactNode;
  tone: 'muted' | 'error';
  title: string;
  body: string;
  onRetry?: () => void;
}

const StatusCard: React.FC<StatusCardProps> = ({ icon, tone, title, body, onRetry }) => (
  <div className="rounded-2xl border border-surface-variant bg-surface p-6 shadow-m3 text-center space-y-4 animate-in fade-in duration-200">
    <div
      className={
        'flex h-12 w-12 items-center justify-center rounded-full mx-auto ' +
        (tone === 'error' ? 'bg-error-container text-error' : 'bg-surface-variant text-text-secondary')
      }
    >
      {icon}
    </div>
    <div className="space-y-1">
      <h1 className="text-base font-bold text-text-primary">{title}</h1>
      <p className="text-xs text-text-secondary leading-relaxed">{body}</p>
    </div>
    <div className="space-y-2 pt-1">
      {onRetry && (
        <button
          onClick={onRetry}
          className="w-full flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-3.5 text-sm font-semibold transition-all btn-tactile shadow-sm touch-target"
        >
          <RefreshCw className="h-4 w-4" />
          <span>Try again</span>
        </button>
      )}
      <Link
        to="/join"
        className="w-full inline-flex items-center justify-center gap-2 rounded-pill bg-surface-variant hover:bg-surface-variant/80 text-text-primary py-3 text-xs font-semibold transition-all touch-target"
      >
        <KeyRound className="h-3.5 w-3.5" />
        <span>Enter backup code</span>
      </Link>
    </div>
    <div className="flex items-center justify-center gap-1.5 pt-1 text-[11px] text-text-muted">
      <ShieldCheck className="h-3.5 w-3.5 text-success" />
      <span>No account • No cloud storage</span>
    </div>
  </div>
);
