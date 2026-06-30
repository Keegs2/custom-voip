/**
 * Recursive folder tree for the document library's left rail.
 *
 * FolderContextMenu  → per-folder rename/delete popover
 * FolderItem         → one row (expand toggle, icon, name/inline-edit, count, menu)
 * FolderTree         → builds the parent→children map and renders the hierarchy
 */

import { useEffect, useRef, useState } from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  MoreVertical,
  Edit,
  Trash2,
} from 'lucide-react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import type { DocumentFolder } from '../../../types/documents';
import { InlineEdit } from './InlineEdit';
import { folderRow, folderCountChip, menuSurface, menuItem } from '../styles';

/* ── Context menu ─────────────────────────────────────────── */

interface FolderMenuProps {
  folder: DocumentFolder;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function FolderContextMenu({ folder, onRename, onDelete, onClose }: FolderMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={ref} style={{ ...menuSurface, minWidth: 140 }}>
      <button
        type="button"
        onClick={() => { onRename(); onClose(); }}
        style={menuItem()}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = GLASS.text; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = GLASS.textMuted; }}
      >
        <Edit size={13} strokeWidth={2} />
        Rename
      </button>
      <button
        type="button"
        onClick={() => { onDelete(); onClose(); }}
        style={menuItem(true)}
        onMouseEnter={(e) => { e.currentTarget.style.background = hexToRgba(GLASS.danger, 0.1); }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        <Trash2 size={13} strokeWidth={2} />
        Delete folder
      </button>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        Folder: {folder.name}
      </span>
    </div>
  );
}

/* ── Folder item ──────────────────────────────────────────── */

interface FolderItemProps {
  folder: DocumentFolder;
  depth: number;
  isSelected: boolean;
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  children?: DocumentFolder[];
}

function FolderItem({ folder, depth, isSelected, onSelect, onRename, onDelete, children = [] }: FolderItemProps) {
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const hasChildren = children.length > 0;

  return (
    <div>
      <div
        style={folderRow(isSelected, depth)}
        onClick={() => { if (!editing) onSelect(folder.id); }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)';
            (e.currentTarget as HTMLDivElement).style.color = GLASS.text;
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            (e.currentTarget as HTMLDivElement).style.color = GLASS.textMuted;
          }
        }}
      >
        {/* Expand toggle */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: 'inherit', flexShrink: 0 }}
          >
            <ChevronRight
              size={12}
              strokeWidth={2.5}
              style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
            />
          </button>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        {/* Folder icon */}
        <span style={{ flexShrink: 0, display: 'flex' }}>
          {isSelected
            ? <FolderOpen size={15} strokeWidth={1.8} color="#60a5fa" />
            : <Folder size={15} strokeWidth={1.8} />}
        </span>

        {/* Name or inline edit */}
        {editing ? (
          <InlineEdit
            initialValue={folder.name}
            onSave={(name) => { onRename(folder.id, name); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            style={{
              flex: 1, fontSize: '0.825rem', fontWeight: isSelected ? 600 : 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: isSelected ? GLASS.text : 'inherit',
            }}
          >
            {folder.name}
          </span>
        )}

        {/* Doc count chip */}
        {!editing && folder.document_count > 0 && (
          <span style={folderCountChip}>{folder.document_count}</span>
        )}

        {/* Context menu trigger */}
        {!editing && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px',
                borderRadius: 5, color: GLASS.textMuted, display: 'flex',
                opacity: showMenu ? 1 : 0.55, transition: 'opacity 0.1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = GLASS.text; }}
              onMouseLeave={(e) => { if (!showMenu) { e.currentTarget.style.opacity = '0.55'; e.currentTarget.style.color = GLASS.textMuted; } }}
            >
              <MoreVertical size={13} strokeWidth={2} />
            </button>
            {showMenu && (
              <FolderContextMenu
                folder={folder}
                onRename={() => setEditing(true)}
                onDelete={() => onDelete(folder.id)}
                onClose={() => setShowMenu(false)}
              />
            )}
          </div>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <FolderItem
              key={child.id}
              folder={child}
              depth={depth + 1}
              isSelected={isSelected && false /* child handles own selection */}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Tree (recursive) ─────────────────────────────────────── */

interface FolderTreeProps {
  folders: DocumentFolder[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}

export function FolderTree({ folders, selectedId, onSelect, onRename, onDelete }: FolderTreeProps) {
  const childrenMap = new Map<number | null, DocumentFolder[]>();
  for (const f of folders) {
    const key = f.parent_id;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(f);
  }

  const topLevel = childrenMap.get(null) ?? [];

  return (
    <>
      {topLevel.map((folder) => (
        <FolderItem
          key={folder.id}
          folder={folder}
          depth={0}
          isSelected={selectedId === folder.id}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
        >
          {childrenMap.get(folder.id) ?? []}
        </FolderItem>
      ))}
    </>
  );
}
