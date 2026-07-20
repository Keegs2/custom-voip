/**
 * DocActionMenu — the per-document popover (download / edit / move / delete),
 * shared by the list-row and grid-card views.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Download,
  Edit,
  FolderOpen,
  Folder,
  Trash2,
  ChevronRight,
} from 'lucide-react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import type { SharedDocument, DocumentFolder } from '../../../types/documents';
import { menuSurface, menuItem } from '../styles';

interface DocMenuProps {
  doc: SharedDocument;
  folders: DocumentFolder[];
  onDownload: () => void;
  onEditDesc: () => void;
  onMove: (folderId: number | null) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function DocActionMenu({ doc, folders, onDownload, onEditDesc, onMove, onDelete, onClose }: DocMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [showMove, setShowMove] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const item = (onClick: () => void, label: string, icon: React.ReactNode, danger = false) => (
    <button
      type="button"
      onClick={onClick}
      style={menuItem(danger)}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? hexToRgba(GLASS.danger, 0.1) : 'rgba(255,255,255,0.06)';
        if (!danger) e.currentTarget.style.color = GLASS.text;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'none';
        e.currentTarget.style.color = danger ? GLASS.danger : GLASS.textMuted;
      }}
    >
      {icon}
      {label}
    </button>
  );

  const moveTarget = (folderId: number | null, label: string) => {
    const active = doc.folder_id === folderId;
    return (
      <button
        key={folderId ?? 'root'}
        type="button"
        onClick={() => { onMove(folderId); onClose(); }}
        style={{
          ...menuItem(),
          padding: '7px 14px 7px 22px',
          fontSize: '0.78rem',
          color: active ? GLASS.accent : GLASS.textMuted,
        }}
      >
        <Folder size={12} strokeWidth={2} /> {label}
      </button>
    );
  };

  return (
    <div ref={ref} style={menuSurface}>
      {item(() => { onDownload(); onClose(); }, 'Download', <Download size={13} strokeWidth={2} />)}
      {item(() => { onEditDesc(); onClose(); }, 'Edit description', <Edit size={13} strokeWidth={2} />)}
      <button
        type="button"
        onClick={() => setShowMove((v) => !v)}
        style={{ ...menuItem(), justifyContent: 'space-between' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = GLASS.text; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = GLASS.textMuted; }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <FolderOpen size={13} strokeWidth={2} />
          Move to folder
        </span>
        <ChevronRight size={12} strokeWidth={2} style={{ transform: showMove ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {showMove && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 4 }}>
          {moveTarget(null, 'Root (All Documents)')}
          {folders.map((f) => moveTarget(f.id, f.name))}
        </div>
      )}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />
      {item(() => { onDelete(); onClose(); }, 'Delete', <Trash2 size={13} strokeWidth={2} />, true)}
    </div>
  );
}
