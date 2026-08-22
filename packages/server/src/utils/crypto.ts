import crypto from 'node:crypto';

/**
 * Generate a cryptographically secure random token (256 bits of entropy encoded as hex).
 */
export function generateSecureToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Compute the SHA-256 hash of a token for secure ephemeral storage.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate an easy-to-read 6-character uppercase alphanumeric code (excluding ambiguous chars 0, O, 1, I).
 */
export function generateNumericCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/**
 * Generate a 4-digit customer code.
 */
export function generateCustomerCode(): string {
  return crypto.randomInt(1000, 10000).toString();
}
