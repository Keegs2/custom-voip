/**
 * Local types + consts for the Documents feature folder.
 *
 * Page-global document types still come from `src/types/documents.ts`; only the
 * feature-local view mode / page size / mime taxonomy live here.
 */

export type ViewMode = 'list' | 'grid';

export type MimeCategory =
  | 'image'
  | 'pdf'
  | 'spreadsheet'
  | 'video'
  | 'audio'
  | 'doc'
  | 'generic';

/** Page size for the initial document fetch / "showing X of Y" count. */
export const PAGE_SIZE = 40;
