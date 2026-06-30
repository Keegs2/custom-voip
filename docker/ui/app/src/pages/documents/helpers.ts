/**
 * Pure presentation helpers for the Documents feature.
 *
 * These are framework-free functions (no JSX), kept out of any `.tsx` module so
 * the component files can stay "only export components" (react-refresh) while
 * still sharing the mime taxonomy + formatters.
 */

import type { DocumentFolder } from '../../types/documents';
import type { MimeCategory } from './types';

/** Human-readable byte size: `0 B` / `1.4 KB` / `2.3 MB` / `1.10 GB`. */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Relative-friendly date: `Just now` / `5m ago` / `Yesterday` / `Mar 3`. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) {
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH === 0) {
      const diffM = Math.floor(diffMs / 60000);
      return diffM < 2 ? 'Just now' : `${diffM}m ago`;
    }
    return `${diffH}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: diffDays > 365 ? 'numeric' : undefined });
}

/** Bucket a MIME string into one of the icon/colour categories. */
export function getMimeCategory(mime: string): MimeCategory {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') return 'spreadsheet';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (
    mime.includes('word') ||
    mime.includes('document') ||
    mime === 'text/plain' ||
    mime === 'text/markdown'
  ) return 'doc';
  return 'generic';
}

/** The accent colour for a mime category (file-type icon tint). */
export function mimeColor(cat: MimeCategory): string {
  switch (cat) {
    case 'image':       return '#a78bfa';
    case 'pdf':         return '#f87171';
    case 'spreadsheet': return '#4ade80';
    case 'video':       return '#f59e0b';
    case 'audio':       return '#38bdf8';
    case 'doc':         return '#60a5fa';
    default:            return '#94a3b8';
  }
}

/** Walk parent links from the selected folder up to the root for the breadcrumb. */
export function buildBreadcrumb(folders: DocumentFolder[], selectedId: number | null): DocumentFolder[] {
  if (selectedId === null) return [];
  const map = new Map(folders.map((f) => [f.id, f]));
  const path: DocumentFolder[] = [];
  let current: DocumentFolder | undefined = map.get(selectedId);
  while (current) {
    path.unshift(current);
    current = current.parent_id !== null ? map.get(current.parent_id) : undefined;
  }
  return path;
}
