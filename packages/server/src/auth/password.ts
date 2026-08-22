import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing for shop-owner accounts (spec §7, §19).
 *
 * Uses Node's built-in scrypt — a memory-hard KDF — so no third-party hashing
 * dependency is introduced. The stored string is fully self-describing:
 *
 *     scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
 *
 * The cost parameters travel with the hash, so they can be raised later without
 * invalidating existing hashes. Passwords themselves are NEVER logged, returned in
 * an API response, or stored anywhere except as this one-way hash.
 */

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

// Cost parameters. 128 * N * r ≈ 16 MiB of memory per hash at these values, which
// is under scrypt's 32 MiB default maxmem ceiling.
const N = 16384; // CPU/memory cost (2^14)
const R = 8; // block size
const P = 1; // parallelization
const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash in constant time.
 * Returns false (never throws) on any malformed/legacy hash string.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}
