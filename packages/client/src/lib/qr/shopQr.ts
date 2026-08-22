/**
 * Permanent-QR URL helpers (spec §14, §E). The printed shop QR encodes ONLY the
 * `publicShopId` as a customer-entry URL — never a token, secret, or session id. The
 * customer path is `/s/:publicShopId`, which resolves the shop and bridges to its current
 * transfer session (spec §16). This URL never expires because the `publicShopId` is
 * permanent.
 */
import { PUBLIC_SHOP_ID_REGEX } from '@quickdrop/shared';

/** Customer-entry route prefix for a scanned permanent shop QR. */
export const SHOP_QR_PATH_PREFIX = '/s/';

/** Build the absolute customer-entry URL for a shop's permanent QR. */
export function buildShopQrUrl(origin: string, publicShopId: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}${SHOP_QR_PATH_PREFIX}${publicShopId}`;
}

/** True when the string matches the canonical `QD-XXXXXX` public shop id format. */
export function isValidPublicShopId(publicShopId: string): boolean {
  return PUBLIC_SHOP_ID_REGEX.test(publicShopId);
}
