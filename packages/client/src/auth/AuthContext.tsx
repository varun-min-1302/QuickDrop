import React, { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
import type { AuthUser } from '@quickdrop/shared';
import { authReducer, initialAuthState, type AuthState } from './authState.js';
import { ApiError } from '../lib/api/http.js';
import { fetchMe, loginOwner, logoutOwner, registerOwner } from '../lib/api/auth.js';

/**
 * App-wide owner-authentication context (spec §7–§9). Wrap the app once in
 * {@link AuthProvider}; consume via {@link useAuth}.
 *
 * On mount it probes `/api/auth/me` to hydrate the "am I signed in" flag from the
 * HttpOnly cookie — the only client-visible auth state. `login`/`register` resolve the
 * session and return the user (or throw {@link ApiError} for the caller to display);
 * `logout` clears local state even if the network call fails (it is idempotent server-side).
 */
export interface AuthContextValue extends AuthState {
  /** True while the initial `/me` probe is in flight. */
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /** Re-probe `/api/auth/me` (e.g. after a 401 elsewhere). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      dispatch({ type: 'RESOLVED', user: me.authenticated && me.user ? me.user : null });
    } catch {
      // A failed probe (network/proxy) must not crash the app — treat as signed out.
      dispatch({ type: 'RESOLVED', user: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolveUser = useCallback((email: string, password: string, fn: typeof loginOwner) => {
    return async (): Promise<AuthUser> => {
      const me = await fn(email, password);
      if (!me.authenticated || !me.user) {
        dispatch({ type: 'RESOLVED', user: null });
        throw new ApiError(500, 'UNEXPECTED', 'The server did not return an account.');
      }
      dispatch({ type: 'RESOLVED', user: me.user });
      return me.user;
    };
  }, []);

  const login = useCallback(
    (email: string, password: string) => resolveUser(email, password, loginOwner)(),
    [resolveUser]
  );

  const register = useCallback(
    (email: string, password: string) => resolveUser(email, password, registerOwner)(),
    [resolveUser]
  );

  const logout = useCallback(async () => {
    try {
      await logoutOwner();
    } finally {
      dispatch({ type: 'LOGGED_OUT' });
    }
  }, []);

  const value: AuthContextValue = {
    ...state,
    loading: state.status === 'loading',
    login,
    register,
    logout,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

/** Access the auth context. Throws if used outside {@link AuthProvider}. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>.');
  return ctx;
}
