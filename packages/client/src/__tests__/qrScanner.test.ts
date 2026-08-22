import { describe, it, expect } from 'vitest';
import { parseAndValidateQuickDropQr } from '../lib/qr/qrValidator.js';

describe('In-Browser QR Validation & Security Rules', () => {
  const currentOrigin = 'https://4542-202-53-15-75.ngrok-free.app';

  it('recognizes valid QuickDrop full URL with hash fragment', () => {
    const validUrl = `${currentOrigin}/#abc123token-secret-999`;
    const result = parseAndValidateQuickDropQr(validUrl, currentOrigin);

    expect(result.valid).toBe(true);
    expect(result.token).toBe('abc123token-secret-999');
    expect(result.error).toBeUndefined();
  });

  it('recognizes valid QuickDrop relative hash format', () => {
    const relativeHash = '/#my-secure-token-555';
    const result = parseAndValidateQuickDropQr(relativeHash, currentOrigin);

    expect(result.valid).toBe(true);
    expect(result.token).toBe('my-secure-token-555');
  });

  it('recognizes valid localhost / 127.0.0.1 QuickDrop URL during development', () => {
    const localhostUrl = 'http://localhost:5173/#dev-token-12345';
    const result = parseAndValidateQuickDropQr(localhostUrl, currentOrigin);

    expect(result.valid).toBe(true);
    expect(result.token).toBe('dev-token-12345');
  });

  it('rejects arbitrary external URLs (e.g. YouTube, Google)', () => {
    const youtubeUrl = 'https://youtube.com/watch?v=12345';
    const result = parseAndValidateQuickDropQr(youtubeUrl, currentOrigin);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("This QR code isn't a QuickDrop shop QR.");
    expect(result.token).toBeUndefined();
  });

  it('rejects plain text and arbitrary strings', () => {
    const randomText = 'WIFI:S:MyNetwork;T:WPA;P:secret123;;';
    const result = parseAndValidateQuickDropQr(randomText, currentOrigin);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("This QR code isn't a QuickDrop shop QR.");
  });

  it('rejects QuickDrop URL missing hash fragment', () => {
    const missingHashUrl = `${currentOrigin}/shop`;
    const result = parseAndValidateQuickDropQr(missingHashUrl, currentOrigin);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("This QR code isn't a QuickDrop shop QR.");
  });

  it('ensures extracted tokens are NEVER saved to localStorage or sessionStorage', () => {
    const validUrl = `${currentOrigin}/#isolated-mem-token-777`;
    const result = parseAndValidateQuickDropQr(validUrl, currentOrigin);

    expect(result.valid).toBe(true);

    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('token')).toBeNull();
      expect(localStorage.getItem('qr_token')).toBeNull();
    }
    if (typeof sessionStorage !== 'undefined') {
      expect(sessionStorage.getItem('token')).toBeNull();
      expect(sessionStorage.getItem('qr_token')).toBeNull();
    }
  });
});

describe('Permanent shop QR (/s/:publicShopId) validation', () => {
  const currentOrigin = 'https://4542-202-53-15-75.ngrok-free.app';
  const PID = 'QD-7F82A9';

  it('recognizes an absolute permanent-shop URL and classifies it as a shop QR', () => {
    const result = parseAndValidateQuickDropQr(`${currentOrigin}/s/${PID}`, currentOrigin);
    expect(result.valid).toBe(true);
    expect(result.kind).toBe('shop');
    expect(result.publicShopId).toBe(PID);
    // A shop QR carries no ephemeral token.
    expect(result.token).toBeUndefined();
  });

  it('recognizes a relative /s/ shorthand', () => {
    const result = parseAndValidateQuickDropQr(`/s/${PID}`, currentOrigin);
    expect(result.valid).toBe(true);
    expect(result.kind).toBe('shop');
    expect(result.publicShopId).toBe(PID);
  });

  it('normalizes a lowercase public shop id to canonical uppercase', () => {
    const result = parseAndValidateQuickDropQr(`${currentOrigin}/s/qd-7f82a9`, currentOrigin);
    expect(result.valid).toBe(true);
    expect(result.publicShopId).toBe(PID);
  });

  it('accepts a permanent-shop URL on localhost during development', () => {
    const result = parseAndValidateQuickDropQr(`http://localhost:5173/s/${PID}`, currentOrigin);
    expect(result.valid).toBe(true);
    expect(result.kind).toBe('shop');
    expect(result.publicShopId).toBe(PID);
  });

  it('tolerates a trailing slash after the shop id', () => {
    const result = parseAndValidateQuickDropQr(`${currentOrigin}/s/${PID}/`, currentOrigin);
    expect(result.valid).toBe(true);
    expect(result.publicShopId).toBe(PID);
  });

  it('rejects a /s/ path whose id does not match the QD-XXXXXX format', () => {
    const result = parseAndValidateQuickDropQr(`${currentOrigin}/s/HELLO`, currentOrigin);
    expect(result.valid).toBe(false);
    expect(result.publicShopId).toBeUndefined();
    expect(result.error).toBe("This QR code isn't a QuickDrop shop QR.");
  });

  it('rejects a permanent-shop URL hosted on a foreign origin', () => {
    const result = parseAndValidateQuickDropQr(`https://evil.example.com/s/${PID}`, currentOrigin);
    expect(result.valid).toBe(false);
    expect(result.publicShopId).toBeUndefined();
  });
});

