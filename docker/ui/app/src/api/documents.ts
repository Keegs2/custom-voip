import { apiRequest } from './client';
import type {
  DocumentFolder,
  SharedDocument,
  DocumentStats,
  DocumentListResult,
  DocumentListParams,
} from '../types/documents';

/* ─── Folders ────────────────────────────────────────────── */

/**
 * Fetch the full folder tree with document counts.
 */
export async function listFolders(): Promise<DocumentFolder[]> {
  return apiRequest<DocumentFolder[]>('GET', '/documents/folders');
}

/**
 * Create a new folder, optionally nested under a parent.
 */
export async function createFolder(name: string, parent_id?: number | null): Promise<DocumentFolder> {
  return apiRequest<DocumentFolder>('POST', '/documents/folders', {
    name,
    parent_id: parent_id ?? null,
  });
}

/**
 * Rename a folder.
 */
export async function renameFolder(id: number, name: string): Promise<DocumentFolder> {
  return apiRequest<DocumentFolder>('PUT', `/documents/folders/${id}`, { name });
}

/**
 * Delete a folder (and its contents, per server rules).
 */
export async function deleteFolder(id: number): Promise<void> {
  return apiRequest<void>('DELETE', `/documents/folders/${id}`);
}

/* ─── Documents ──────────────────────────────────────────── */

/**
 * List documents with optional filters and pagination.
 */
export async function listDocuments(params: DocumentListParams = {}): Promise<DocumentListResult> {
  const query = new URLSearchParams();
  if (params.folder_id !== undefined && params.folder_id !== null) {
    query.set('folder_id', String(params.folder_id));
  }
  if (params.search) query.set('search', params.search);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiRequest<DocumentListResult>('GET', `/documents${qs ? `?${qs}` : ''}`);
}

/**
 * Upload a single file using multipart form data.
 * Returns the created SharedDocument on success.
 * Calls onProgress with 0–100 as the upload proceeds.
 */
export async function uploadDocument(
  file: File,
  options: { folder_id?: number | null; description?: string; tags?: string[] } = {},
  onProgress?: (pct: number) => void,
): Promise<SharedDocument> {
  const token = localStorage.getItem('auth_token');
  const formData = new FormData();
  formData.append('file', file);
  if (options.folder_id !== undefined && options.folder_id !== null) {
    formData.append('folder_id', String(options.folder_id));
  }
  if (options.description) formData.append('description', options.description);
  if (options.tags && options.tags.length > 0) {
    // Send tags as a JSON string; the server decodes it
    formData.append('tags', JSON.stringify(options.tags));
  }

  return new Promise<SharedDocument>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as SharedDocument);
        } catch {
          reject(new Error('Invalid response from server'));
        }
      } else {
        let message = 'Upload failed';
        try {
          const body = JSON.parse(xhr.responseText) as Record<string, unknown>;
          if (typeof body['detail'] === 'string') message = body['detail'];
        } catch { /* noop */ }
        reject(new Error(message));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.open('POST', '/api/documents/upload');
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(formData);
  });
}

/**
 * Trigger a file download for the given document ID.
 * Opens the download URL in the same tab so the browser handles the save dialog.
 */
export function downloadDocument(id: number, originalFilename?: string): void {
  const token = localStorage.getItem('auth_token');
  void (async () => {
    const response = await fetch(`/api/documents/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return;
    const blob = await response.blob();
    // Use provided original filename, fall back to Content-Disposition header, then generic name
    let filename = originalFilename;
    if (!filename) {
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const match = /filename[^;=\n]*=(['"]?)([^'";\n]+)\1/.exec(disposition);
      filename = match ? match[2] : `document-${id}`;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  })();
}

/**
 * Update document metadata (description, tags, or move to a different folder).
 */
export async function updateDocument(
  id: number,
  patch: { description?: string | null; tags?: string[]; folder_id?: number | null },
): Promise<SharedDocument> {
  return apiRequest<SharedDocument>('PUT', `/documents/${id}`, patch);
}

/**
 * Permanently delete a document.
 */
export async function deleteDocument(id: number): Promise<void> {
  return apiRequest<void>('DELETE', `/documents/${id}`);
}

/* ─── Stats ──────────────────────────────────────────────── */

/**
 * Fetch aggregate storage statistics for the organisation.
 */
export async function getDocumentStats(): Promise<DocumentStats> {
  return apiRequest<DocumentStats>('GET', '/documents/stats');
}
