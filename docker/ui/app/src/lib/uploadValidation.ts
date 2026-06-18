/**
 * Shared client-side upload validation.
 *
 * This is a UX defense-in-depth layer that mirrors the server's upload
 * enforcement (see docker/api/src/routers/documents.py and chat.py). It lets us
 * reject oversized or disallowed files *before* a byte leaves the browser, with
 * a clear, human-readable message. The server remains the source of truth and
 * re-validates every upload — never trust the client.
 *
 * The size constants intentionally track the server defaults:
 *   - Documents: `DOCUMENTS_MAX_FILE_SIZE` env (default 50 MB) in documents.py.
 *   - Chat attachments: kept deliberately smaller than the document library.
 */

/** 50 MB — mirrors the documents API `DOCUMENTS_MAX_FILE_SIZE` default. */
export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024;

/** 25 MB — chat attachments are capped below the document library limit. */
export const MAX_CHAT_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Content-type allowlist for the shared document library.
 *
 * Entries ending in `/*` match a whole MIME family (e.g. `image/*`); all other
 * entries are matched exactly. This covers the file categories the server's
 * stats endpoint recognises (image/video/audio/pdf/text/office) plus common
 * archive and data formats, while excluding executables and scripts.
 */
export const DOCUMENT_ALLOWED_CONTENT_TYPES = [
  'image/*',
  'video/*',
  'audio/*',
  'text/*',
  'application/pdf',
  'application/json',
  'application/rtf',
  'application/zip',
  'application/gzip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
] as const;

/**
 * Content-type allowlist for chat attachments — tighter than documents:
 * images plus the everyday document formats people drop into a conversation.
 */
export const CHAT_ATTACHMENT_ALLOWED_CONTENT_TYPES = [
  'image/*',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export interface UploadConstraints {
  /** Maximum allowed file size in bytes. */
  maxBytes: number;
  /** Allowed content types (`type/*` families or exact types). Empty = allow all. */
  allowedContentTypes: readonly string[];
  /** Human label used in error messages, e.g. "document" or "attachment". */
  label: string;
}

export type UploadValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/** Document-library upload constraints. */
export const DOCUMENT_UPLOAD_CONSTRAINTS: UploadConstraints = {
  maxBytes: MAX_DOCUMENT_SIZE_BYTES,
  allowedContentTypes: DOCUMENT_ALLOWED_CONTENT_TYPES,
  label: 'document',
};

/** Chat-attachment upload constraints. */
export const CHAT_ATTACHMENT_CONSTRAINTS: UploadConstraints = {
  maxBytes: MAX_CHAT_ATTACHMENT_SIZE_BYTES,
  allowedContentTypes: CHAT_ATTACHMENT_ALLOWED_CONTENT_TYPES,
  label: 'attachment',
};

/** Format a byte count as a compact human-readable string (e.g. "50 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Returns true if `type` is permitted by `allowed`.
 *
 * - An empty allowlist permits everything.
 * - A blank/unknown `file.type` is deferred to the server: many legitimate
 *   files (e.g. some .csv/.md) report no MIME type in the browser, so we let
 *   the server make the final call rather than over-rejecting here.
 */
export function isContentTypeAllowed(type: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const t = (type || '').trim().toLowerCase();
  if (!t) return true;
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.endsWith('/*')) return t.startsWith(pattern.slice(0, -1));
    return t === pattern;
  });
}

/**
 * Validate a single file against the given constraints.
 * Returns `{ ok: true }` or `{ ok: false, error }` with a user-facing message.
 */
export function validateUpload(file: File, constraints: UploadConstraints): UploadValidationResult {
  if (file.size === 0) {
    return { ok: false, error: `"${file.name}" is empty and cannot be uploaded.` };
  }
  if (file.size > constraints.maxBytes) {
    return {
      ok: false,
      error: `"${file.name}" is ${formatBytes(file.size)}, which exceeds the ${formatBytes(
        constraints.maxBytes,
      )} limit.`,
    };
  }
  if (!isContentTypeAllowed(file.type, constraints.allowedContentTypes)) {
    return {
      ok: false,
      error: `"${file.name}" is a ${file.type || 'unknown'} file, which is not an allowed ${
        constraints.label
      } type.`,
    };
  }
  return { ok: true };
}
