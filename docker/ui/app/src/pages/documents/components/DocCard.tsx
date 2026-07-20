/**
 * DocCard — one document in the grid view. A frosted glass tile with a preview
 * header (image thumbnail or type icon), filename + meta, tags, and the action
 * menu. Lifts + accent-glows on hover.
 */

import { useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { GLASS, glassSurface, hexToRgba } from '../../../components/glass/glass';
import { GlassSheen } from '../../../components/glass/GlassCard';
import type { SharedDocument, DocumentFolder } from '../../../types/documents';
import { FileTypeIcon } from './FileTypeIcon';
import { DocActionMenu } from './DocActionMenu';
import { formatFileSize, formatDate, getMimeCategory, mimeColor } from '../helpers';
import { docNameBtn, tagChip, gridPreview } from '../styles';

interface DocCardProps {
  doc: SharedDocument;
  folders: DocumentFolder[];
  onDownload: () => void;
  onEdit: () => void;
  onMove: (folderId: number | null) => void;
  onDelete: () => void;
}

export function DocCard({ doc, folders, onDownload, onEdit, onMove, onDelete }: DocCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [nameHover, setNameHover] = useState(false);

  const isImage = doc.mime_type.startsWith('image/');
  const iconColor = mimeColor(getMimeCategory(doc.mime_type));

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...glassSurface({ interactive: true, hovered, radius: 16, blur: 16 }),
        // overflow visible so the action menu can escape; the preview clips itself
        overflow: 'visible',
      }}
    >
      <GlassSheen />

      {/* Preview area */}
      <div
        onClick={onDownload}
        style={{
          ...gridPreview(isImage, iconColor),
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
        }}
      >
        {isImage ? (
          <img
            src={`/api/documents/${doc.id}/download`}
            alt={doc.original_filename}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <FileTypeIcon mime={doc.mime_type} size={36} />
        )}
      </div>

      {/* Info */}
      <div style={{ position: 'relative', zIndex: 1, padding: '12px 14px' }}>
        <button
          type="button"
          onClick={onDownload}
          style={{ ...docNameBtn(nameHover), width: '100%', fontSize: '0.8rem', marginBottom: 4 }}
          onMouseEnter={() => setNameHover(true)}
          onMouseLeave={() => setNameHover(false)}
        >
          {doc.original_filename}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.72rem', color: GLASS.textMuted }}>{formatFileSize(doc.file_size)}</span>
          <span style={{ fontSize: '0.72rem', color: GLASS.textMuted }}>{formatDate(doc.created_at)}</span>
        </div>
        {(doc.tags ?? []).length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            {(doc.tags ?? []).slice(0, 2).map((tag) => (
              <span key={tag} style={{ ...tagChip(), fontSize: '0.58rem' }}>{tag}</span>
            ))}
          </div>
        )}
      </div>

      {/* Menu button */}
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
          style={{
            background: 'rgba(0,0,0,0.5)',
            border: `1px solid ${hexToRgba(GLASS.accent, showMenu ? 0.4 : 0.12)}`,
            borderRadius: 8,
            cursor: 'pointer',
            color: GLASS.textMuted,
            display: 'flex',
            padding: '4px 5px',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
          }}
        >
          <MoreVertical size={13} strokeWidth={2} />
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
