import crypto from 'node:crypto';
import {
  PUBLIC_SHOP_ID_PREFIX,
  PUBLIC_SHOP_ID_ALPHABET,
  PUBLIC_SHOP_ID_BODY_LENGTH,
} from '@quickdrop/shared';

/**
 * Generate the permanent, public shop reference (spec §3): `QD-` + 6 chars from an
 * unambiguous alphabet, e.g. `QD-7F82A9`.
 *
 * This is a PUBLIC identifier printed in the QR, NOT a credential — it grants no
 * access on its own. It is generated with a CSPRNG purely so it is unguessable-ish
 * and collision-resistant, not because it is secret.
 */

// The alphabet has 32 symbols and a byte has 256 values (256 = 32 × 8), so `byte % 32`
// is perfectly uniform — no modulo bias, no rejection sampling required.
const ALPHABET_LEN = PUBLIC_SHOP_ID_ALPHABET.length;

/** One random candidate id. Pure (aside from CSPRNG); does not check uniqueness. */
export function generateCandidatePublicShopId(): string {
  const bytes = crypto.randomBytes(PUBLIC_SHOP_ID_BODY_LENGTH);
  let body = '';
  for (let i = 0; i < PUBLIC_SHOP_ID_BODY_LENGTH; i++) {
    body += PUBLIC_SHOP_ID_ALPHABET[bytes[i] % ALPHABET_LEN];
  }
  return PUBLIC_SHOP_ID_PREFIX + body;
}

const MAX_ATTEMPTS = 10;

/**
 * Generate a candidate id and retry until one is not already taken. The keyspace is
 * 32^6 ≈ 1.07 billion, so a collision is astronomically unlikely; the retry loop is a
 * safety net. `isTaken` is injected so this is trivially unit-testable.
 */
export async function generatePublicShopId(
  isTaken: (candidate: string) => Promise<boolean>
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = generateCandidatePublicShopId();
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`Failed to generate a unique publicShopId after ${MAX_ATTEMPTS} attempts`);
}
