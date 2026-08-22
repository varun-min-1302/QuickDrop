/**
 * Pure state model for owner auth. Kept free of React so the transitions can be unit
 * tested directly (the Node test env cannot render components).
 *
 * Client-visible auth state is intentionally minimal: a status flag plus the safe
 * {@link AuthUser} view (id / email / createdAt). No token, hash, or password ever lives
 * here — the credential is the HttpOnly cookie (spec §8).
 */
import type { AuthUser } from '@quickdrop/shared';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
}

/** Start in `loading` — we probe `/api/auth/me` before we know anything. */
export const initialAuthState: AuthState = { status: 'loading', user: null };

export type AuthAction =
  /** Return to the loading state (e.g. a manual re-probe). */
  | { type: 'LOADING' }
  /** A `/me`, login, or register call settled: `user` present ⇒ authenticated. */
  | { type: 'RESOLVED'; user: AuthUser | null }
  /** Logout completed (or failed but we clear local state regardless). */
  | { type: 'LOGGED_OUT' };

export function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'LOADING':
      return { status: 'loading', user: state.user };
    case 'RESOLVED':
      return action.user
        ? { status: 'authenticated', user: action.user }
        : { status: 'unauthenticated', user: null };
    case 'LOGGED_OUT':
      return { status: 'unauthenticated', user: null };
    default:
      return state;
  }
}
