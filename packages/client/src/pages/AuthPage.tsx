import React, { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Mail, Lock, LogIn, UserPlus, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.js';
import { ApiError } from '../lib/api/http.js';
import { validateEmail, validatePassword, validateLoginPassword } from '../lib/validation.js';

type Mode = 'login' | 'register';

/**
 * Owner sign-in / registration (spec §7). The password lives only in local component
 * state and is sent in the POST body; it is never stored, logged, or placed in the URL.
 * On success the server sets the HttpOnly `qd_auth` cookie and we route the owner onward
 * (to the page they were trying to reach, else shop setup).
 */
export const AuthPage: React.FC = () => {
  const { status, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || '/shop/setup';

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in → don't show the form; go where they were headed.
  if (status === 'authenticated') return <Navigate to={from} replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const emailErr = validateEmail(email);
    const pwErr = mode === 'register' ? validatePassword(password) : validateLoginPassword(password);
    if (emailErr || pwErr) {
      setError(emailErr || pwErr);
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-12">
      <div className="rounded-2xl border border-surface-variant bg-surface p-8 shadow-m3 space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            {mode === 'login' ? 'Sign in to your shop' : 'Create your shop account'}
          </h1>
          <p className="text-xs text-text-secondary">
            {mode === 'login'
              ? 'Access your permanent shop dashboard and QR code.'
              : 'One account manages your permanent shop identity.'}
          </p>
        </div>

        {/* Mode toggle */}
        <div className="flex rounded-pill bg-surface-variant p-1 text-xs font-medium">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={`flex-1 rounded-pill py-2 transition-colors ${
              mode === 'login' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary'
            }`}
          >
            Sign In
          </button>
          <button
            type="button"
            onClick={() => switchMode('register')}
            className={`flex-1 rounded-pill py-2 transition-colors ${
              mode === 'register' ? 'bg-primary text-white shadow-sm' : 'text-text-secondary'
            }`}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Email</span>
            <div className="flex items-center gap-2 rounded-xl border border-surface-variant bg-background px-3 py-2.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30 transition-all">
              <Mail className="h-4 w-4 text-text-muted shrink-0" />
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@shop.com"
                className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                required
              />
            </div>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">Password</span>
            <div className="flex items-center gap-2 rounded-xl border border-surface-variant bg-background px-3 py-2.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30 transition-all">
              <Lock className="h-4 w-4 text-text-muted shrink-0" />
              <input
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
                className="w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                required
              />
            </div>
          </label>

          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-error-container p-3 text-xs font-medium text-error">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-pill bg-primary px-5 py-3 text-sm font-semibold text-white transition-all btn-tactile shadow-sm disabled:opacity-50 touch-target"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === 'login' ? (
              <LogIn className="h-4 w-4" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            <span>{mode === 'login' ? 'Sign In' : 'Create Account'}</span>
          </button>
        </form>

        <div className="flex items-center justify-center gap-1.5 text-[11px] text-text-muted">
          <ShieldCheck className="h-3.5 w-3.5 text-success" />
          <span>Passwords are hashed and never stored in your browser.</span>
        </div>
      </div>
    </div>
  );
};
