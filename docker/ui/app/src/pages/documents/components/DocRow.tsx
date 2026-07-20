/**
 * DocRow — one document in the list (table) view. Hover lift, inline tags,
 * filename downloads on click, and the per-doc action menu.
 */

import { useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import type { SharedDocument, DocumentFolder } from '../../../types/documents';
import { FileTypeIcon } from './FileTypeIcon';
import { DocActionMenu } from './DocActionMenu';
import { formatFileSize, formatDate } from '../helpers';
import { GLASS } from '../../../components/glass/glass';
import { docRow, docNameBtn, docMeta, tagChip, iconActionBtn } from '../styles';

interface DocRowProps {
  doc: SharedDocument;
  folders: DocumentFolder[];
  onDownload: () => void;
  onEdit: () => void;
  onMove: (folderId: number | null) => void;
  onDelete: () => void;
}

export function DocRow({ doc, folders, onDownload, onEdit, onMove, onDelete }: DocRowProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [nameHover, setNameHover] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <div
      style={docRow(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Type icon */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <FileTypeIcon mime={doc.mime_type} size={18} />
      </div>

      {/* Name + description + tags */}
      <div style={{ minWidth: 0 }}>
        <button
          type="button"
          onClick={onDownload}
          style={docNameBtn(nameHover)}
          onMouseEnter={() => setNameHover(true)}
          onMouseLeave={() => setNameHover(false)}
        >
          {doc.original_filename}
        </button>
        {doc.description && (
          <div style={{ fontSize: '0.72rem', color: GLASS.textFaint, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc.description}
          </div>
        )}
        {(doc.tags ?? []).length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {(doc.tags ?? []).slice(0, 3).map((tag) => (
              <span key={tag} style={tagChip()}>{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* Size */}
      <div style={{ ...docMeta, textAlign: 'right' }}>{formatFileSize(doc.file_size)}</div>

      {/* Uploader */}
      <div style={docMeta}>{doc.uploader_name}</div>

      {/* Date */}
      <div style={{ ...docMeta, fontSize: '0.78rem' }}>{formatDate(doc.created_at)}</div>

      {/* Actions */}
      <div ref={menuRef} style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
        <button
          type="button"
          onClick={() => setShowMenu((v) => !v)}
          style={iconActionBtn(showMenu)}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = GLASS.text; }}
          onMouseLeave={(e) => { if (!showMenu) { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = GLASS.textMuted; } }}
        >
          <MoreVertical size={15} strokeWidth={2} />
        </button>
        {showMenu && (
          <DocActionMenu
            doc={doc}
            folders={folders}
            onDownload={onDownload}
            onEditDesc={onEdit}
            onMove={onMove}
            onDelete={onDelete}
            onClose={() => setShowMenu(false)}
          />
        )}
      </div>
    </div>
  );
}
