import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { Navbar } from './components/Navbar.js';
import { ShopDashboardPage } from './pages/ShopDashboardPage.js';
import { CustomerTransferPage } from './pages/CustomerTransferPage.js';
import { CustomerJoinPage } from './pages/CustomerJoinPage.js';
import { ShopEntryPage } from './pages/ShopEntryPage.js';
import { AuthPage } from './pages/AuthPage.js';
import { ShopSetupPage } from './pages/ShopSetupPage.js';
import { ShopQrPage } from './pages/ShopQrPage.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { Store, Smartphone, ShieldCheck, ArrowRight } from 'lucide-react';

const RootDispatcher: React.FC = () => {
  const [hasHash, setHasHash] = useState(() => !!window.location.hash);

  useEffect(() => {
    const handleHashChange = () => {
      setHasHash(!!window.location.hash);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // If customer scanned QR code (has hash token), immediately render Customer Transfer UI
  if (hasHash) {
    return <CustomerTransferPage />;
  }

  // Otherwise, render landing/mode selector
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 space-y-8 text-center">
      <div className="space-y-3 max-w-lg mx-auto">
        <h1 className="text-3xl font-bold tracking-tight text-text-primary">
          Scan. Send. Print.
        </h1>
        <p className="text-sm text-text-secondary leading-relaxed">
          QuickDrop is a privacy-first temporary document transfer platform for print shops, cyber cafés, and document counters.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-2xl mx-auto pt-4 text-left">
        {/* Shop Operator Card */}
        <Link
          to="/shop"
          className="flex flex-col justify-between rounded-2xl border border-surface-variant bg-surface p-6 shadow-m3 hover:border-primary hover:shadow-m3-elevated transition-all btn-tactile group"
        >
          <div className="space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-container text-primary">
              <Store className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary group-hover:text-primary transition-colors">
              Shop Operator
            </h2>
            <p className="text-xs text-text-secondary leading-relaxed">
              Sign in to open your shop dashboard, display your permanent QR, and receive print jobs directly.
            </p>
          </div>

          <div className="flex items-center gap-1.5 text-xs font-semibold text-primary pt-6">
            <span>Open Shop Dashboard</span>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </div>
        </Link>

        {/* Customer Card */}
        <Link
          to="/join"
          className="flex flex-col justify-between rounded-2xl border border-surface-variant bg-surface p-6 shadow-m3 hover:border-primary hover:shadow-m3-elevated transition-all btn-tactile group"
        >
          <div className="space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-variant text-text-primary">
              <Smartphone className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary group-hover:text-primary transition-colors">
              Customer Transfer
            </h2>
            <p className="text-xs text-text-secondary leading-relaxed">
              Enter a 6-character backup code if you didn't scan the QR code with your camera.
            </p>
          </div>

          <div className="flex items-center gap-1.5 text-xs font-semibold text-primary pt-6">
            <span>Enter Backup Code</span>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </div>
        </Link>
      </div>

      <div className="flex items-center justify-center gap-6 pt-8 text-xs text-text-muted">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-success" /> No App Needed
        </span>
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-success" /> No Account Required
        </span>
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-success" /> 0% Cloud File Storage
        </span>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  const [isDark, setIsDark] = useState<boolean>(() => {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col bg-background text-text-primary">
        <Navbar onToggleTheme={() => setIsDark((d) => !d)} isDark={isDark} />
        <div className="flex-1">
          <Routes>
            <Route path="/" element={<RootDispatcher />} />
            <Route path="/join" element={<CustomerJoinPage />} />
            <Route path="/s/:publicShopId" element={<ShopEntryPage />} />
            <Route path="/customer" element={<CustomerTransferPage />} />
            <Route path="/login" element={<AuthPage />} />
            <Route
              path="/shop/setup"
              element={
                <RequireAuth>
                  <ShopSetupPage />
                </RequireAuth>
              }
            />
            <Route
              path="/shop/qr"
              element={
                <RequireAuth>
                  <ShopQrPage />
                </RequireAuth>
              }
            />
            <Route
              path="/shop/dashboard"
              element={
                <RequireAuth>
                  <ShopDashboardPage />
                </RequireAuth>
              }
            />
            <Route
              path="/shop"
              element={
                <RequireAuth>
                  <ShopDashboardPage />
                </RequireAuth>
              }
            />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
};
