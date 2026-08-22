import { LIMITS, ALLOWED_FILE_EXTENSIONS, AllowedFileExtension } from '@quickdrop/shared';

/**
 * Sanitize a filename to prevent path traversal, XSS, or illegal characters.
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return 'document.pdf';

  // 1. Remove path traversal prefixes like ../ and ..\
  let clean = filename.replace(/(\.\.[\\/])+/g, '');

  // 2. Remove drive letters like C:\ or D:/
  clean = clean.replace(/^[a-zA-Z]:[\\/]/, '');

  // 3. Remove control characters, null bytes, and non-printable characters
  clean = clean.replace(/[\x00-\x1f\x80-\x9f]/g, '');

  // 4. Replace dangerous HTML/shell special characters and path slashes
  clean = clean.replace(/[<>:"/\\|?*#~`$%^&]/g, '_');

  // 5. Disallow hidden filenames starting with a dot
  clean = clean.replace(/^\.+/, '');

  // 6. Trim whitespace and limit length
  clean = clean.trim().slice(0, LIMITS.MAX_FILENAME_LENGTH);

  return clean || 'document';
}

/**
 * Format bytes into human-readable string (e.g. "2.4 MB", "840 KB")
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Format remaining seconds into "0.4 sec remaining" or "1m 12s"
 */
export function formatRemainingTime(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return 'calculating...';
  if (seconds < 60) return `~${seconds.toFixed(1)}s left`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `~${mins}m ${secs}s left`;
}

/**
 * Check if a file extension is allowed.
 */
export function isAllowedFile(filename: string, size: number): { valid: boolean; error?: string } {
  const parts = filename.split('.');
  if (parts.length < 2) {
    return { valid: false, error: 'File must have an extension' };
  }

  const ext = parts.pop()?.toLowerCase() as AllowedFileExtension;
  if (!ALLOWED_FILE_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Unsupported file type (.${ext}). Allowed: PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, JPG, PNG, TXT.`,
    };
  }

  if (size > LIMITS.MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File exceeds maximum allowed size of ${formatBytes(LIMITS.MAX_FILE_SIZE_BYTES)}.`,
    };
  }

  if (size <= 0) {
    return { valid: false, error: 'File is empty.' };
  }

  return { valid: true };
}
