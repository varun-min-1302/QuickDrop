export const PROTOCOL_VERSION = '1.0' as const;

export const LIMITS = {
  /** Maximum size allowed for a single file: 50 MB */
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
  /** Maximum total transferred bytes per session: 200 MB */
  MAX_SESSION_TRANSFER_BYTES: 200 * 1024 * 1024,
  /** Maximum number of files permitted in a single session */
  MAX_FILES_PER_SESSION: 20,
  /** Default session TTL: 15 minutes in seconds */
  DEFAULT_SESSION_TTL_SECONDS: 15 * 60,
  /** Default WebRTC chunk size: 64 KiB */
  CHUNK_SIZE_BYTES: 64 * 1024,
  /** Backpressure high watermark: 4 MiB */
  BUFFERED_AMOUNT_HIGH_WATERMARK: 4 * 1024 * 1024,
  /** Backpressure low watermark: 1 MiB */
  BUFFERED_AMOUNT_LOW_WATERMARK: 1 * 1024 * 1024,
  /** Maximum filename length allowed */
  MAX_FILENAME_LENGTH: 120,
} as const;

export const ALLOWED_FILE_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'jpg',
  'jpeg',
  'png',
  'txt',
] as const;

export type AllowedFileExtension = (typeof ALLOWED_FILE_EXTENSIONS)[number];

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'text/plain',
] as const;

export const EXTENSION_MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  txt: 'text/plain',
};
