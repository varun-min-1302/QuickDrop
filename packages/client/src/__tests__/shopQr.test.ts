import { describe, it, expect } from 'vitest';
import { buildShopQrUrl, isValidPublicShopId, SHOP_QR_PATH_PREFIX } from '../lib/qr/shopQr.js';

/**
 * Sub-phase 3 (permanent-QR poster) test gate. The printed QR must encode ONLY the
 * `/s/:publicShopId` customer-entry URL — no token, secret, or session id (spec §14, §E).
 */
describe('permanent shop QR helpers', () => {
  it('builds an absolute /s/:publicShopId URL', () => {
    expect(buildShopQrUrl('https://quickdrop.app', 'QD-7F82A9')).toBe('https://quickdrop.app/s/QD-7F82A9');
  });

  it('normalizes trailing slashes on the origin', () => {
    expect(buildShopQrUrl('https://quickdrop.app/', 'QD-7F82A9')).toBe('https://quickdrop.app/s/QD-7F82A9');
    expect(buildShopQrUrl('http://localhost:5173//', 'QD-ABCDEF')).toBe('http://localhost:5173/s/QD-ABCDEF');
  });

  it('encodes only the publicShopId — never a token, secret, or hash fragment', () => {
    const url = buildShopQrUrl('https://quickdrop.app', 'QD-7F82A9');
    expect(url).toContain(SHOP_QR_PATH_PREFIX);
    expect(url).not.toMatch(/token|secret|#/i);
  });

  it('validates the canonical QD-XXXXXX format and rejects malformed codes', () => {
    expect(isValidPublicShopId('QD-7F82A9')).toBe(true);
    expect(isValidPublicShopId('QD-ABC')).toBe(false); // too short
    expect(isValidPublicShopId('XX-7F82A9')).toBe(false); // wrong prefix
    expect(isValidPublicShopId('QD-7F82A0')).toBe(false); // 0 is not in the alphabet
    expect(isValidPublicShopId('qd-7f82a9')).toBe(false); // lowercase
  });
});
