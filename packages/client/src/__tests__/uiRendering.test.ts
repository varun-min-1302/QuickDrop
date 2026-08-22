import { describe, it, expect } from 'vitest';
import { sanitizeFilename, isAllowedFile, formatBytes, formatRemainingTime } from '../lib/transfer/sanitizer.js';

describe('Frontend Foundation & UI Helpers', () => {
  it('correctly calculates remaining time strings for transfer stats', () => {
    expect(formatRemainingTime(0.4)).toBe('~0.4s left');
    expect(formatRemainingTime(15)).toBe('~15.0s left');
    expect(formatRemainingTime(75)).toBe('~1m 15s left');
    expect(formatRemainingTime(-5)).toBe('calculating...');
  });

  it('correctly formats file sizes into human-readable strings', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1024 * 500)).toBe('500 KB');
    expect(formatBytes(1024 * 1024 * 2.4)).toBe('2.4 MB');
    expect(formatBytes(1024 * 1024 * 50)).toBe('50 MB');
  });

  it('enforces allowed file types and limits in FilePicker validation', () => {
    expect(isAllowedFile('project.pdf', 1000).valid).toBe(true);
    expect(isAllowedFile('photo.jpg', 2000).valid).toBe(true);
    expect(isAllowedFile('notes.docx', 3000).valid).toBe(true);
    expect(isAllowedFile('slides.pptx', 4000).valid).toBe(true);
    expect(isAllowedFile('data.xlsx', 5000).valid).toBe(true);
    expect(isAllowedFile('script.py', 1000).valid).toBe(false);
    expect(isAllowedFile('app.exe', 1000).valid).toBe(false);
    expect(isAllowedFile('large.pdf', 55 * 1024 * 1024).valid).toBe(false);
  });

  it('sanitizes filenames accurately', () => {
    expect(sanitizeFilename('my_assignment.pdf')).toBe('my_assignment.pdf');
    expect(sanitizeFilename('../../passwords.txt')).toBe('passwords.txt');
    expect(sanitizeFilename('file<name>:test.png')).toBe('file_name__test.png');
  });
});
