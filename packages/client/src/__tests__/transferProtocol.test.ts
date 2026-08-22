import { describe, it, expect } from 'vitest';
import { encodeChunkPacket, decodeChunkPacket } from '../lib/transfer/protocol.js';
import { sanitizeFilename, formatBytes, isAllowedFile } from '../lib/transfer/sanitizer.js';

describe('Transfer Protocol & Sanitizer', () => {
  it('encodes and decodes binary chunk packet with 40-byte header accurately', () => {
    const transferId = '123e4567-e89b-12d3-a456-426614174000';
    const chunkIndex = 42;
    const rawPayload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer;

    const encoded = encodeChunkPacket(transferId, chunkIndex, rawPayload);
    expect(encoded.byteLength).toBe(40 + 8);

    const decoded = decodeChunkPacket(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.transferId).toBe(transferId);
    expect(decoded?.chunkIndex).toBe(42);
    expect(decoded?.data.length).toBe(8);
    expect(Array.from(decoded?.data || [])).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('sanitizes dangerous filenames preventing path traversal and XSS', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeFilename('..\\..\\Windows\\System32\\cmd.exe')).toBe('Windows_System32_cmd.exe');
    expect(sanitizeFilename('<script>alert(1)</script>.pdf')).toBe('_script_alert(1)__script_.pdf');
    expect(sanitizeFilename('.hidden_file.docx')).toBe('hidden_file.docx');
    expect(sanitizeFilename('normal_document.pdf')).toBe('normal_document.pdf');
  });

  it('validates allowed extensions and file sizes', () => {
    expect(isAllowedFile('resume.pdf', 1024 * 1024).valid).toBe(true);
    expect(isAllowedFile('sheet.xlsx', 5000).valid).toBe(true);
    expect(isAllowedFile('malware.exe', 1024).valid).toBe(false);
    expect(isAllowedFile('script.sh', 1024).valid).toBe(false);
    expect(isAllowedFile('huge.pdf', 60 * 1024 * 1024).valid).toBe(false); // > 50 MB
  });

  it('formats byte strings nicely', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});
