/**
 * FolderRail — the left frosted column: header with "New folder", the
 * "All Documents" root entry, and the recursive folder tree.
 */

import { useState } from 'react';
import { Folder, FolderOpen, FolderPlus } from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import { GlassSheen } from '../../../components/glass/GlassCard';
import type { DocumentFolder, DocumentStats } from '../../../types/documents';
import { FolderTree } from './FolderTree';
import {
  glassColumn,
  railHeader,
  railLabel,
  newFolderBtn,
  folderRow,
  folderCountChip,
} from '../styles';

interface FolderRailProps {
  folders: DocumentFolder[];
  selectedFolderId: number | null;
  stats: DocumentStats | null;
  onSelect: (id: number | null) => void;
  onNewFolder: () => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}

export function FolderRail({
  folders, selectedFolderId, stats, onSelect, onNewFolder, onRename, onDelete,
}: FolderRailProps) {
  const [newHover, setNewHover] = useState(false);
  const rootSelected = selectedFolderId === null;

  return (
    <div style={glassColumn({ width: 280, flexShrink: 0 })}>
      <GlassSheen />

      {/* Header */}
      <div style={{ ...railHeader, position: 'relative', zIndex: 1 }}>
        <span style={railLabel}>Folders</span>
        <button
          type="button"
          onClick={onNewFolder}
          title="New folder"
          style={newFolderBtn(newHover)}
          onMouseEnter={() => setNewHover(true)}
          onMouseLeave={() => setNewHover(false)}
        >
          <FolderPlus size={13} strokeWidth={2} />
          New
        </button>
      </div>

      {/* Scrollable list */}
      <div style={{ position: 'relative', zIndex: 1, flex: 1, overflowY: 'auto', padding: 8 }}>
        {/* All Documents root */}
        <div
          onClick={() => onSelect(null)}
          style={{ ...folderRow(rootSelected), marginBottom: 4 }}
          onMouseEnter={(e) => {
            if (!rootSelected) {
              (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)';
              (e.currentTarget as HTMLDivElement).style.color = GLASS.text;
            }
          }}
          onMouseLeave={(e) => {
            if (!rootSelected) {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
              (e.currentTarget as HTMLDivElement).style.color = GLASS.textMuted;
            }
          }}
        >
          {rootSelected
            ? <FolderOpen size={15} color="#60a5fa" strokeWidth={1.8} />
            : <Folder size={15} strokeWidth={1.8} />}
          <span style={{ flex: 1, fontSize: '0.825rem', fontWeight: rootSelected ? 700 : 500, color: rootSelected ? GLASS.text : 'inherit' }}>
            All Documents
          </span>
          {stats && <span style={folderCountChip}>{stats.total_documents}</span>}
        </div>

        <FolderTree
          folders={folders}
          selectedId={selectedFolderId}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
}
