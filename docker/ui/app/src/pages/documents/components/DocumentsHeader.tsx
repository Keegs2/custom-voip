/**
 * DocumentsHeader — the top bar of the main panel: folder breadcrumb, library
 * stats, search, list/grid view toggle, and the Upload button.
 */

import { useState } from 'react';
import {
  FolderOpen,
  ChevronRight,
  Search,
  List,
  Grid,
  Upload,
  HardDrive,
} from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import type { DocumentFolder, DocumentStats } from '../../../types/documents';
import type { ViewMode } from '../types';
import { formatFileSize } from '../helpers';
import {
  headerBar,
  breadcrumbBtn,
  searchWrap,
  searchInput,
  viewToggleWrap,
  viewToggleBtn,
  uploadBtn,
  statsBar,
} from '../styles';

interface DocumentsHeaderProps {
  breadcrumb: DocumentFolder[];
  selectedFolderId: number | null;
  onSelectFolder: (id: number | null) => void;
  stats: DocumentStats | null;
  searchDraft: string;
  onSearch: (value: string) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  onUpload: () => void;
}

export function DocumentsHeader({
  breadcrumb, selectedFolderId, onSelectFolder, stats, searchDraft, onSearch, view, onView, onUpload,
}: DocumentsHeaderProps) {
  const [focused, setFocused] = useState(false);
  const [uploadHover, setUploadHover] = useState(false);

  return (
    <div style={headerBar}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <button
          type="button"
          onClick={() => onSelectFolder(null)}
          style={breadcrumbBtn(selectedFolderId === null)}
        >
          <FolderOpen size={15} strokeWidth={1.8} color={selectedFolderId === null ? '#60a5fa' : 'currentColor'} />
          All Documents
        </button>
        {breadcrumb.map((folder) => (
          <div key={folder.id} style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <ChevronRight size={13} color={GLASS.textFaint} strokeWidth={2.5} />
            <button
              type="button"
              onClick={() => onSelectFolder(folder.id)}
              style={breadcrumbBtn(selectedFolderId === folder.id)}
            >
              {folder.name}
            </button>
          </div>
        ))}
      </div>

      {/* Stats */}
      {stats && (
        <div style={statsBar}>
          <HardDrive size={13} strokeWidth={2} color={GLASS.textMuted} />
          <span>
            {stats.total_documents.toLocaleString()} {stats.total_documents === 1 ? 'file' : 'files'}
            {' · '}
            {formatFileSize(stats.total_size)}
          </span>
        </div>
      )}

      {/* Search */}
      <div style={searchWrap(focused)}>
        <Search size={14} color={focused ? GLASS.accent : GLASS.textFaint} strokeWidth={2} style={{ flexShrink: 0 }} />
        <input
          value={searchDraft}
          onChange={(e) => onSearch(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search documents…"
          style={searchInput}
        />
      </div>

      {/* View toggle */}
      <div style={viewToggleWrap}>
        <button type="button" onClick={() => onView('list')} title="List view" style={viewToggleBtn(view === 'list')}>
          <List size={15} strokeWidth={2} />
        </button>
        <button type="button" onClick={() => onView('grid')} title="Grid view" style={viewToggleBtn(view === 'grid')}>
          <Grid size={15} strokeWidth={2} />
        </button>
      </div>

      {/* Upload */}
      <button
        type="button"
        onClick={onUpload}
        style={uploadBtn(uploadHover)}
        onMouseEnter={() => setUploadHover(true)}
        onMouseLeave={() => setUploadHover(false)}
      >
        <Upload size={15} strokeWidth={2.5} />
        Upload
      </button>
    </div>
  );
}
