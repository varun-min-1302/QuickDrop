import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './AuthContext.js';

/** Centered loader shown while the initial `/api/auth/me` probe is in flight. */
const AuthLoading: React.FC = () => (
  <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-text-secondary">
    <Loader2 className="h-6 w-6 animate-spin text-primary" />
    <p className="text-xs">Checking your session…</p>
  </div>
);

/**
 * Route guard for owner-only pages (spec §9). While the session is resolving it shows a
 * loader; once resolved it renders the protected children when authenticated, or
 * redirects to `/login` (preserving the intended path so login can send the owner back).
 *
 * This is a client-side convenience only — the server independently authorizes every
 * shop-management request (401/403/404), so a forged client state cannot grant access.
 */
export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <AuthLoading />;

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children}</>;
};
