/**
 * Compute SHA-256 hex string of a File or Blob using Web Crypto API.
 */
export async function computeSHA256(file: Blob | File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hexString = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return hexString;
}

/**
 * Compute SHA-256 hex string of an ArrayBuffer or Uint8Array.
 */
export async function computeBufferSHA256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
