import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ShopSummary } from '@quickdrop/shared';
import {
  Store,
  Copy,
  Check,
  LogOut,
  Loader2,
  AlertCircle,
  ArrowRight,
  PlusCircle,
  ShieldCheck,
  QrCode,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext.js';
import { ApiError } from '../lib/api/http.js';
import { createShop, listShops } from '../lib/api/shops.js';
import { validateShopName } from '../lib/validation.js';

/**
 * Onboarding + permanent shop identity (spec §5). Rendered behind {@link RequireAuth}.
 *
 * On load it fetches the owner's shops. With none, it shows the one-time create form;
 * once a shop exists it shows the PERMANENT identity — the `publicShopId` (QD-XXXXXX)
 * that will live on the printed QR and never expires. The dashboard and printable QR
 * poster are reached from here.
 */
export const ShopSetupPage: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [shop, setShop] = useState<ShopSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const nameErr = validateShopName(name);
    if (nameErr) {
      setError(nameErr);
      return;
    }
    setCreating(true);
    try {
      const created = await createShop(name.trim());
      setShop(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your shop.');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = useCallback(async () => {
    if (!shop) return;
    try {
      await navigator.clipboard?.writeText(shop.publicShopId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code is visible on screen regardless */
    }
  }, [shop]);

  const handleLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-text-secondary">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-xs">Loading your shop…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-12 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="text-text-muted">Signed in as</span>
          <span className="font-medium text-text-primary">{user?.email}</span>
        </div>
        <button
          onClick={handleLogout}
          className="inline-flex items-center gap-1.5 rounded-pill bg-surface-variant px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-error hover:bg-error-container transition-colors btn-tactile"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>Sign out</span>
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-error-container p-3 text-xs font-medium text-error">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {shop ? (
        <div className="rounded-2xl border border-surface-variant bg-surface p-8 shadow-m3 space-y-6">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-container text-primary">
              <Store className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-text-primary">{shop.name}</h1>
              <p className="text-xs text-text-secondary">Your permanent shop identity</p>
            </div>
          </div>

          <div className="rounded-xl border border-dashed border-primary/40 bg-primary-container/20 p-5 text-center space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              Permanent Shop Code
            </p>
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-widest text-primary">
                {shop.publicShopId}
              </span>
              <button
                onClick={handleCopy}
                aria-label="Copy shop code"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant text-text-secondary hover:text-primary btn-tactile"
              >
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-[11px] text-text-secondary">
              This never changes and is safe to print. It is not a password.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Link
              to="/shop"
              className="inline-flex items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile shadow-sm touch-target"
            >
              <span>Open Dashboard</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/shop/qr"
              className="inline-flex items-center justify-center gap-2 rounded-pill bg-surface-variant px-5 py-3 text-sm font-semibold text-text-primary btn-tactile touch-target"
            >
              <QrCode className="h-4 w-4" />
              <span>View printable QR poster</span>
            </Link>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-surface-variant bg-surface p-8 shadow-m3 space-y-6">
          <div className="space-y-1.5">
            <h1 className="text-xl font-bold tracking-tight text-text-primary">Set up your shop</h1>
            <p className="text-xs text-text-secondary">
              Give your shop a name. We’ll generate a permanent code and QR you can print once and reuse forever.
            </p>
          </div>

          <form onSubmit={handleCreate} className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-text-secondary">Shop name</span>
              <div className="flex items-center gap-2 rounded-xl border border-surface-variant bg-background px-3 py-2.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30 transition-all">
                <Store className="h-4 w-4 text-text-muted shrink-0" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Main Street Print & Copy"
                  maxLength={80}
                  className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                  required
                />
              </div>
            </label>

            <button
              type="submit"
              disabled={creating}
              className="inline-flex w-full items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white btn-tactile shadow-sm disabled:opacity-50 touch-target"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlusCircle className="h-4 w-4" />}
              <span>Create Shop</span>
            </button>
          </form>

          <div className="flex items-center justify-center gap-1.5 text-[11px] text-text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-success" />
            <span>Documents are never stored — transfers stay peer-to-peer.</span>
          </div>
        </div>
      )}
    </div>
  );
};
