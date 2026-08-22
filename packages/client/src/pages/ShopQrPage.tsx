import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import type { ShopSummary } from '@quickdrop/shared';
import { Printer, Loader2, AlertCircle, ArrowLeft, Store } from 'lucide-react';
import { ApiError } from '../lib/api/http.js';
import { listShops } from '../lib/api/shops.js';
import { buildShopQrUrl } from '../lib/qr/shopQr.js';

/**
 * Printable permanent-QR poster (spec §14, §E). Rendered behind {@link RequireAuth}.
 *
 * The QR encodes only the customer-entry URL `/s/:publicShopId` — a permanent link that
 * never expires (unlike the temporary transfer-session QR). The owner prints this once and
 * displays it at the counter forever.
 */
export const ShopQrPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState<ShopSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    (async () => {
      try {
        const shops = await listShops(controller.signal);
        if (active) setShop(shops[0] ?? null);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (active) setError(err instanceof ApiError ? err.message : 'Could not load your shop.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const qrUrl = shop ? buildShopQrUrl(window.location.origin, shop.publicShopId) : '';

  useEffect(() => {
    if (canvasRef.current && qrUrl) {
      // Black on white for maximum print/scan reliability.
      QRCode.toCanvas(canvasRef.current, qrUrl, {
        width: 320,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch((err) => console.error('QR rendering error:', err));
    }
  }, [qrUrl]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-text-secondary">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-xs">Loading your shop QR…</p>
      </div>
    );
  }

  if (!shop) {
    return (
      <div className="mx-auto max-w-md px-4 py-12 space-y-4 text-center">
        {error && (
          <div className="flex items-center gap-2 rounded-xl bg-error-container p-3 text-xs font-medium text-error">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <p className="text-sm text-text-secondary">You don’t have a shop yet.</p>
        <Link
          to="/shop/setup"
          className="inline-flex items-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile"
        >
          <Store className="h-4 w-4" />
          <span>Set up your shop</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8 space-y-4">
      {/* Actions (hidden when printing) */}
      <div className="flex items-center justify-between print:hidden">
        <Link
          to="/shop/setup"
          className="inline-flex items-center gap-1.5 rounded-pill bg-surface-variant px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary btn-tactile"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back</span>
        </Link>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-pill bg-primary px-5 py-2.5 text-sm font-semibold text-white btn-tactile shadow-sm"
        >
          <Printer className="h-4 w-4" />
          <span>Print Poster</span>
        </button>
      </div>

      {/* The poster itself */}
      <div className="rounded-2xl border border-surface-variant bg-white p-8 text-center shadow-m3 print:border-0 print:shadow-none">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-text-muted">Scan to send documents</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-gray-900">{shop.name}</h1>

        <div className="my-6 flex justify-center">
          <div className="rounded-xl border border-gray-200 bg-white p-3">
            <canvas ref={canvasRef} aria-label={`QR code for ${shop.name}`} className="rounded-md" />
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-xs text-gray-500">No app needed — just your phone camera.</p>
          <p className="text-sm text-gray-700">
            Or go to <span className="font-mono">{qrUrl}</span>
          </p>
          <p className="text-sm text-gray-700">
            Shop code: <span className="font-mono text-lg font-bold tracking-widest text-primary">{shop.publicShopId}</span>
          </p>
        </div>

        <ol className="mx-auto mt-6 max-w-xs space-y-1.5 text-left text-xs text-gray-600">
          <li>1. Open your phone camera and point it at the QR code.</li>
          <li>2. Tap the link that appears.</li>
          <li>3. Choose your files — they transfer directly to the shop.</li>
        </ol>
      </div>
    </div>
  );
};
