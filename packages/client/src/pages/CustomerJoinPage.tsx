import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, Smartphone, ArrowRight, ShieldCheck } from 'lucide-react';

export const CustomerJoinPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if token is passed via search query ?token=... or hash #...
    const queryToken = searchParams.get('token');
    const hashToken = window.location.hash.replace(/^#/, '').trim();
    const token = queryToken || hashToken;

    if (token) {
      navigate(`/customer#${token}`, { replace: true });
    }
  }, [searchParams, navigate]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (clean.length < 4) {
      setError('Please enter a valid 6-character backup code.');
      return;
    }
    navigate(`/customer#${clean}`);
  };

  return (
    <div className="mx-auto max-w-md px-4 py-12 space-y-6">
      <div className="text-center space-y-2">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-container text-primary mx-auto mb-3 shadow-xs">
          <Smartphone className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-bold text-text-primary">Join Print Session</h1>
        <p className="text-xs text-text-secondary max-w-xs mx-auto">
          Scan the QR code at the shop counter or enter the 6-character backup code displayed on the screen.
        </p>
      </div>

      <div className="rounded-2xl border border-surface-variant bg-surface p-6 shadow-m3 space-y-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="backup-code" className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
              Shop Backup Code
            </label>
            <div className="relative">
              <input
                id="backup-code"
                type="text"
                maxLength={6}
                value={code}
                onChange={(e) => {
                  setError(null);
                  setCode(e.target.value.toUpperCase());
                }}
                placeholder="e.g. X7K92P"
                className="w-full text-center tracking-widest uppercase font-mono text-xl py-3.5 px-4 rounded-xl border border-surface-variant bg-surface-variant/40 text-text-primary focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                autoComplete="off"
                aria-describedby={error ? 'code-error' : undefined}
              />
              <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-text-muted pointer-events-none" />
            </div>
            {error && (
              <p id="code-error" className="text-xs text-error mt-2 font-medium">
                {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={code.trim().length < 4}
            className="w-full flex items-center justify-center gap-2 rounded-pill bg-primary hover:bg-primary-hover text-white py-3.5 text-sm font-semibold transition-all btn-tactile shadow-sm disabled:opacity-50 touch-target"
          >
            <span>Connect to Shop</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </div>

      <div className="rounded-xl border border-surface-variant bg-surface-variant/30 p-4 text-center space-y-1 text-xs text-text-secondary">
        <div className="flex items-center justify-center gap-1.5 font-semibold text-text-primary">
          <ShieldCheck className="h-4 w-4 text-success" />
          <span>Zero Sign-In Required</span>
        </div>
        <p className="text-[11px] text-text-muted">
          No account, phone number, or app download required.
        </p>
      </div>
    </div>
  );
};
