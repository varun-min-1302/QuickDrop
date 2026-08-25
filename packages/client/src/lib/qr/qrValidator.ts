/**
 * Validates whether a scanned QR code text is a legitimate QuickDrop QR and classifies it.
 *
 * Two kinds are recognised (spec §14/§16):
 *   - `shop`  — the PERMANENT shop QR, a customer-entry URL `…/s/QD-XXXXXX`. It encodes
 *               ONLY the `publicShopId` (never a token/secret) and never expires. The
 *               customer flow resolves it and bridges to the shop's current session.
 *   - `token` — the legacy ephemeral session QR `…/#<joinToken>`, still supported so an
 *               already-open transfer session's QR keeps working.
 *
 * The permanent-shop kind is preferred: it is checked before the hash-token forms.
 */
import { isValidPublicShopId } from './shopQr.js';

export type QrScanResult =
  | { kind: 'shop'; publicShopId: string }
  | { kind: 'token'; token: string };

export interface QrValidationResult {
  valid: boolean;
  /** Which QuickDrop QR kind was recognised (only when `valid`). */
  kind?: 'shop' | 'token';
  /** The ephemeral join token — present only for `kind: 'token'`. */
  token?: string;
  /** The permanent public shop id — present only for `kind: 'shop'`. */
  publicShopId?: string;
  error?: string;
}

const INVALID_MSG = "This QR code isn't a QuickDrop shop QR.";
const invalid = (): QrValidationResult => ({ valid: false, error: INVALID_MSG });

/** Normalise + validate a candidate public shop id extracted from a `/s/…` path. */
function shopResult(rawId: string): QrValidationResult {
  const publicShopId = rawId.trim().toUpperCase();
  return isValidPublicShopId(publicShopId)
    ? { valid: true, kind: 'shop', publicShopId }
    : invalid();
}

const tokenResult = (rawToken: string): QrValidationResult => {
  const token = rawToken.trim();
  return token ? { valid: true, kind: 'token', token } : invalid();
};

export function parseAndValidateQuickDropQr(
  scannedText: string,
  expectedOrigin: string = window.location.origin
): QrValidationResult {
  if (!scannedText || typeof scannedText !== 'string') {
    return invalid();
  }

  const trimmed = scannedText.trim();

  // 1. Permanent-shop path shorthand (relative), e.g. "/s/QD-7F82A9".
  if (trimmed.startsWith('/s/')) {
    const seg = trimmed.slice(3).split(/[?#]/)[0];
    return shopResult(seg);
  }

  // 2. Legacy token fragment shorthand, e.g. "#<token>" or "/#<token>".
  if (trimmed.startsWith('/#')) {
    return tokenResult(trimmed.slice(2));
  }
  if (trimmed.startsWith('#')) {
    return tokenResult(trimmed.slice(1));
  }

  // 3. Full URL validation.
  try {
    const url = new URL(trimmed);

    // Origin check: must match the current app origin, the public app origin, or localhost for dev.
    const currentUrl = new URL(expectedOrigin);
    const expectedAppOrigin = (import.meta as { env?: { VITE_PUBLIC_APP_URL?: string } }).env?.VITE_PUBLIC_APP_URL;
    let isPublicHost = false;
    try {
      if (expectedAppOrigin) {
        isPublicHost = url.host === new URL(expectedAppOrigin).host;
      }
    } catch { /* ignore invalid public origin env var */ }
    
    const isSameHost = url.host === currentUrl.host || isPublicHost;
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const originAllowed = isSameHost || isLocalhost;

    // 3a. Permanent-shop path "/s/QD-XXXXXX" (has no hash fragment).
    const shopMatch = url.pathname.match(/^\/s\/([^/]+)\/?$/);
    if (shopMatch) {
      return originAllowed ? shopResult(decodeURIComponent(shopMatch[1])) : invalid();
    }

    // 3b. Legacy token carried in the URL hash fragment.
    const hash = url.hash.replace(/^#/, '').trim();
    if (!hash) {
      return invalid();
    }
    return originAllowed ? tokenResult(hash) : invalid();
  } catch {
    return invalid();
  }
}
