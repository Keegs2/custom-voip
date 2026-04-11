/**
 * DocumentsPage — full-screen shared document library.
 *
 * Layout:
 *   Sidebar | 280px folder tree | Right panel (header + doc list/grid + upload)
 *
 * The folder tree on the left filters the document list on the right.
 * Documents can be uploaded via drag-and-drop or a file picker.
 * List and grid views are both supported.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ChangeEvent,
} from 'react';
import {
  FolderOpen,
  Folder,
  FolderPlus,
  FileText,
  FileImage,
  FileSpreadsheet,
  FileVideo,
  FileAudio,
  File,
  Upload,
  Download,
  Trash2,
  Edit,
  Search,
  Grid,
  List,
  MoreVertical,
  HardDrive,
  ChevronRight,
  X,
  Check,
  Plus,
} from 'lucide-react';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import {
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  listDocuments,
  uploadDocument,
  downloadDocument,
  updateDocument,
  deleteDocument,
  getDocumentStats,
} from '../api/documents';
// Auth enforced by RequireAuth route wrapper
import type {
  DocumentFolder,
  SharedDocument,
  DocumentStats,
  UploadProgress,
} from '../types/documents';

/* ─── Keyframe injection ─────────────────────────────────── */

const GLOBAL_STYLES = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes docFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes progressPulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.6; }
  }
`;

/* ─── Helpers ────────────────────────────────────────────── */

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string): string {
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

function getMimeCategory(mime: string): 'image' | 'pdf' | 'spreadsheet' | 'video' | 'audio' | 'doc' | 'generic' {
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

interface FileIconProps {
  mime: string;
  size?: number;
  color?: string;
}

function FileTypeIcon({ mime, size = 20, color }: FileIconProps) {
  const cat = getMimeCategory(mime);
  const resolvedColor = color ?? (
    cat === 'image'       ? '#a78bfa' :
    cat === 'pdf'         ? '#f87171' :
    cat === 'spreadsheet' ? '#4ade80' :
    cat === 'video'       ? '#f59e0b' :
    cat === 'audio'       ? '#38bdf8' :
    cat === 'doc'         ? '#60a5fa' :
    '#94a3b8'
  );

  const props = { size, color: resolvedColor, strokeWidth: 1.6 };

  switch (cat) {
    case 'image':       return <FileImage {...props} />;
    case 'pdf':         return <FileText {...props} />;
    case 'spreadsheet': return <FileSpreadsheet {...props} />;
    case 'video':       return <FileVideo {...props} />;
    case 'audio':       return <FileAudio {...props} />;
    case 'doc':         return <FileText {...props} />;
    default:            return <File {...props} />;
  }
}

/* ─── Build folder path breadcrumb ──────────────────────── */

function buildBreadcrumb(folders: DocumentFolder[], selectedId: number | null): DocumentFolder[] {
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

/* ─── Inline edit input ──────────────────────────────────── */

interface InlineEditProps {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

function InlineEdit({ initialValue, onSave, onCancel }: InlineEditProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); if (value.trim()) onSave(value.trim()); }
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        style={{
          flex: 1,
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(59,130,246,0.50)',
          borderRadius: 6,
          color: '#e2e8f0',
          fontSize: '0.8rem',
          padding: '3px 7px',
          outline: 'none',
          minWidth: 0,
        }}
      />
      <button
        type="button"
        onClick={() => { if (value.trim()) onSave(value.trim()); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4ade80', padding: 2, display: 'flex' }}
      >
        <Check size={13} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 2, display: 'flex' }}
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </div>
  );
}

/* ─── Folder context menu ────────────────────────────────── */

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
    <div
      ref={ref}
      style={{
        position: 'absolute',
        right: 0,
        top: '100%',
        zIndex: 200,
        background: '#1e2332',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 10,
        padding: '4px 0',
        minWidth: 140,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      <button
        type="button"
        onClick={() => { onRename(); onClose(); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', background: 'none', border: 'none',
          color: '#94a3b8', fontSize: '0.8rem', padding: '8px 14px',
          cursor: 'pointer', textAlign: 'left',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#e2e8f0'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#94a3b8'; }}
      >
        <Edit size={13} strokeWidth={2} />
        Rename
      </button>
      <button
        type="button"
        onClick={() => { onDelete(); onClose(); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', background: 'none', border: 'none',
          color: '#f87171', fontSize: '0.8rem', padding: '8px 14px',
          cursor: 'pointer', textAlign: 'left',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(248,113,113,0.08)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        <Trash2 size={13} strokeWidth={2} />
        Delete folder
      </button>
      {/* Hidden label for screen readers */}
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
        Folder: {folder.name}
      </span>
    </div>
  );
}

/* ─── Folder tree item ───────────────────────────────────── */

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
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: `7px ${14 + depth * 14}px 7px 14px`,
          borderRadius: 8,
          cursor: 'pointer',
          userSelect: 'none',
          background: isSelected
            ? 'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(59,130,246,0.08) 100%)'
            : 'transparent',
          color: isSelected ? '#93c5fd' : '#64748b',
          transition: 'background 0.12s, color 0.12s',
          position: 'relative',
        }}
        onClick={() => { if (!editing) onSelect(folder.id); }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)';
            (e.currentTarget as HTMLDivElement).style.color = '#94a3b8';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            (e.currentTarget as HTMLDivElement).style.color = '#64748b';
          }
        }}
      >
        {/* Expand toggle */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 0, display: 'flex', color: 'inherit', flexShrink: 0,
            }}
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
              color: isSelected ? '#e2e8f0' : 'inherit',
            }}
          >
            {folder.name}
          </span>
        )}

        {/* Doc count chip */}
        {!editing && folder.document_count > 0 && (
          <span
            style={{
              fontSize: '0.65rem', color: '#475569', background: 'rgba(255,255,255,0.06)',
              borderRadius: 4, padding: '1px 5px', flexShrink: 0,
            }}
          >
            {folder.document_count}
          </span>
        )}

        {/* Context menu trigger */}
        {!editing && (
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px',
                borderRadius: 5, color: '#475569', display: 'flex', opacity: 0,
                transition: 'opacity 0.1s',
              }}
              className="folder-menu-btn"
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = '#94a3b8'; }}
              onMouseLeave={(e) => { if (!showMenu) e.currentTarget.style.opacity = '0'; }}
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

/* ─── Folder tree (recursive) ────────────────────────────── */

interface FolderTreeProps {
  folders: DocumentFolder[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
}

function FolderTree({ folders, selectedId, onSelect, onRename, onDelete }: FolderTreeProps) {
  // Build parent→children map
  const childrenMap = new Map<number | null, DocumentFolder[]>();
  for (const f of folders) {
    const key = f.parent_id;
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(f);
  }

  function renderLevel(parentId: number | null, depth: number): React.ReactNode {
    const items = childrenMap.get(parentId) ?? [];
    return items.map((folder) => (
      <FolderItem
        key={folder.id}
        folder={folder}
        depth={depth}
        isSelected={selectedId === folder.id}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
      >
        {childrenMap.get(folder.id) ?? []}
      </FolderItem>
    ));
  }

  return <>{renderLevel(null, 0)}</>;
}

/* ─── Document action menu ───────────────────────────────── */

interface DocMenuProps {
  doc: SharedDocument;
  folders: DocumentFolder[];
  onDownload: () => void;
  onEditDesc: () => void;
  onMove: (folderId: number | null) => void;
  onDelete: () => void;
  onClose: () => void;
}

function DocActionMenu({ doc, folders, onDownload, onEditDesc, onMove, onDelete, onClose }: DocMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [showMove, setShowMove] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const menuBtn = (onClick: () => void, label: string, icon: React.ReactNode, danger = false) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', background: 'none', border: 'none',
        color: danger ? '#f87171' : '#94a3b8',
        fontSize: '0.8rem', padding: '8px 14px',
        cursor: 'pointer', textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? 'rgba(248,113,113,0.08)' : 'rgba(255,255,255,0.05)';
        if (!danger) e.currentTarget.style.color = '#e2e8f0';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'none';
        e.currentTarget.style.color = danger ? '#f87171' : '#94a3b8';
      }}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        right: 0,
        top: '100%',
        zIndex: 200,
        background: '#1e2332',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 10,
        padding: '4px 0',
        minWidth: 180,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {menuBtn(() => { onDownload(); onClose(); }, 'Download', <Download size={13} strokeWidth={2} />)}
      {menuBtn(() => { onEditDesc(); onClose(); }, 'Edit description', <Edit size={13} strokeWidth={2} />)}
      <button
        type="button"
        onClick={() => setShowMove((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between',
          width: '100%', background: 'none', border: 'none',
          color: '#94a3b8', fontSize: '0.8rem', padding: '8px 14px',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#e2e8f0'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#94a3b8'; }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FolderOpen size={13} strokeWidth={2} />
          Move to folder
        </span>
        <ChevronRight size={12} strokeWidth={2} style={{ transform: showMove ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {showMove && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 4 }}>
          <button
            type="button"
            onClick={() => { onMove(null); onClose(); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', background: 'none', border: 'none',
              color: doc.folder_id === null ? '#60a5fa' : '#64748b',
              fontSize: '0.78rem', padding: '7px 14px 7px 22px',
              cursor: 'pointer',
            }}
          >
            <Folder size={12} strokeWidth={2} /> Root (All Documents)
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => { onMove(f.id); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', background: 'none', border: 'none',
                color: doc.folder_id === f.id ? '#60a5fa' : '#64748b',
                fontSize: '0.78rem', padding: '7px 14px 7px 22px',
                cursor: 'pointer',
              }}
            >
              <Folder size={12} strokeWidth={2} /> {f.name}
            </button>
          ))}
        </div>
      )}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 0' }} />
      {menuBtn(() => { onDelete(); onClose(); }, 'Delete', <Trash2 size={13} strokeWidth={2} />, true)}
    </div>
  );
}

/* ─── Edit description modal ─────────────────────────────── */

interface EditDescModalProps {
  doc: SharedDocument;
  onSave: (description: string, tags: string[]) => void;
  onClose: () => void;
}

function EditDescModal({ doc, onSave, onClose }: EditDescModalProps) {
  const [desc, setDesc] = useState(doc.description ?? '');
  const [tagsInput, setTagsInput] = useState((doc.tags ?? []).join(', '));

  const handleSave = () => {
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    onSave(desc, tags);
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#1a1f2e',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 16,
          padding: 28,
          width: 460,
          maxWidth: 'calc(100vw - 40px)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            Edit document
          </div>
          <button
            type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex' }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div style={{ marginBottom: 6, fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Filename
        </div>
        <div style={{ fontSize: '0.875rem', color: '#94a3b8', marginBottom: 18, fontFamily: 'monospace' }}>
          {doc.original_filename}
        </div>

        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ marginBottom: 6, fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Description
          </div>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Add a description…"
            rows={3}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 10, color: '#e2e8f0',
              fontSize: '0.875rem', padding: '10px 14px',
              outline: 'none', resize: 'vertical', fontFamily: 'inherit',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.50)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 24 }}>
          <div style={{ marginBottom: 6, fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Tags (comma-separated)
          </div>
          <input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="report, q4, finance"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 10, color: '#e2e8f0',
              fontSize: '0.875rem', padding: '10px 14px',
              outline: 'none', fontFamily: 'inherit',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.50)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; }}
          />
        </label>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button" onClick={onClose}
            style={{
              padding: '9px 20px', borderRadius: 9,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
              color: '#94a3b8', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button" onClick={handleSave}
            style={{
              padding: '9px 20px', borderRadius: 9,
              background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
              border: 'none', color: '#fff', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
              boxShadow: '0 2px 12px rgba(59,130,246,0.35)',
            }}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── New folder modal ───────────────────────────────────── */

interface NewFolderModalProps {
  parentId: number | null;
  folders: DocumentFolder[];
  onSave: (name: string, parentId: number | null) => void;
  onClose: () => void;
}

function NewFolderModal({ parentId, folders, onSave, onClose }: NewFolderModalProps) {
  const [name, setName] = useState('');
  const [chosenParent, setChosenParent] = useState<number | null>(parentId);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSave = () => { if (name.trim()) onSave(name.trim(), chosenParent); };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#1a1f2e',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 16,
          padding: 28,
          width: 400,
          maxWidth: 'calc(100vw - 40px)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '1rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            <FolderPlus size={18} color="#60a5fa" strokeWidth={1.8} />
            New Folder
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex' }}>
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ marginBottom: 6, fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Folder name
          </div>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marketing Assets"
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 10, color: '#e2e8f0',
              fontSize: '0.875rem', padding: '10px 14px',
              outline: 'none', fontFamily: 'inherit',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.50)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; }}
          />
        </label>

        {folders.length > 0 && (
          <label style={{ display: 'block', marginBottom: 24 }}>
            <div style={{ marginBottom: 6, fontSize: '0.75rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Parent folder (optional)
            </div>
            <select
              value={chosenParent ?? ''}
              onChange={(e) => setChosenParent(e.target.value === '' ? null : Number(e.target.value))}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: '#1a1f2e',
                border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: 10, color: '#e2e8f0',
                fontSize: '0.875rem', padding: '10px 14px',
                outline: 'none',
              }}
            >
              <option value="">Root (no parent)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '9px 20px', borderRadius: 9, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', color: '#94a3b8', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            type="button" onClick={handleSave} disabled={!name.trim()}
            style={{
              padding: '9px 20px', borderRadius: 9,
              background: name.trim() ? 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)' : 'rgba(59,130,246,0.25)',
              border: 'none', color: '#fff', fontSize: '0.875rem', fontWeight: 600,
              cursor: name.trim() ? 'pointer' : 'not-allowed',
              boxShadow: name.trim() ? '0 2px 12px rgba(59,130,246,0.35)' : 'none',
            }}
          >
            Create folder
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Upload progress bar ────────────────────────────────── */

interface UploadQueueProps {
  queue: UploadProgress[];
  onDismiss: (index: number) => void;
}

function UploadQueue({ queue, onDismiss }: UploadQueueProps) {
  if (queue.length === 0) return null;
  const active = queue.filter((u) => u.status !== 'done' || u.status === 'done');

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 400,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 360,
      }}
    >
      {active.map((u, i) => (
        <div
          key={i}
          style={{
            background: '#1a1f2e',
            border: `1px solid ${u.status === 'error' ? 'rgba(248,113,113,0.30)' : u.status === 'done' ? 'rgba(74,222,128,0.25)' : 'rgba(255,255,255,0.10)'}`,
            borderRadius: 12,
            padding: '12px 16px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            animation: 'docFadeIn 0.2s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: u.status === 'uploading' ? 8 : 0 }}>
            <FileTypeIcon mime={u.file.type || 'application/octet-stream'} size={16} />
            <span style={{ flex: 1, fontSize: '0.8rem', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {u.file.name}
            </span>
            <span style={{
              fontSize: '0.7rem', fontWeight: 600,
              color: u.status === 'error' ? '#f87171' : u.status === 'done' ? '#4ade80' : '#94a3b8',
            }}>
              {u.status === 'done' ? 'Done' : u.status === 'error' ? 'Failed' : `${u.progress}%`}
            </span>
            {(u.status === 'done' || u.status === 'error') && (
              <button type="button" onClick={() => onDismiss(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#475569', display: 'flex', padding: 0 }}>
                <X size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          {u.status === 'uploading' && (
            <div style={{ height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 99, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${u.progress}%`,
                  background: 'linear-gradient(90deg, #2563eb, #3b82f6)',
                  borderRadius: 99,
                  transition: 'width 0.2s ease',
                  animation: u.progress < 100 ? 'progressPulse 1.5s ease-in-out infinite' : 'none',
                }}
              />
            </div>
          )}
          {u.status === 'error' && u.error && (
            <div style={{ fontSize: '0.72rem', color: '#f87171', marginTop: 4 }}>{u.error}</div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── Drop zone ──────────────────────────────────────────── */

interface DropZoneProps {
  onFiles: (files: File[]) => void;
}

function DropZone({ onFiles }: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFiles(files);
    e.target.value = '';
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragOver ? 'rgba(59,130,246,0.60)' : 'rgba(255,255,255,0.10)'}`,
        borderRadius: 14,
        padding: '36px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
        background: dragOver ? 'rgba(59,130,246,0.06)' : 'rgba(255,255,255,0.02)',
        transition: 'border-color 0.15s, background 0.15s',
        userSelect: 'none',
        margin: '0 24px 24px',
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: dragOver
            ? 'linear-gradient(135deg, rgba(59,130,246,0.24) 0%, rgba(59,130,246,0.12) 100%)'
            : 'rgba(255,255,255,0.04)',
          border: `1px solid ${dragOver ? 'rgba(59,130,246,0.40)' : 'rgba(255,255,255,0.08)'}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: dragOver ? '#60a5fa' : '#475569',
          transition: 'all 0.15s',
        }}
      >
        <Upload size={22} strokeWidth={1.6} />
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>
          Drop files here or <span style={{ color: '#60a5fa' }}>browse</span>
        </div>
        <div style={{ fontSize: '0.78rem', color: '#334155' }}>
          Any file type · Multiple files supported
        </div>
      </div>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={handleChange} />
    </div>
  );
}

/* ─── Stats bar ──────────────────────────────────────────── */

function StatsBar({ stats }: { stats: DocumentStats | null }) {
  if (!stats) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <HardDrive size={13} strokeWidth={2} color="#475569" />
      <span style={{ fontSize: '0.78rem', color: '#475569' }}>
        {stats.total_documents.toLocaleString()} {stats.total_documents === 1 ? 'file' : 'files'}
        {' · '}
        {formatFileSize(stats.total_size)}
      </span>
    </div>
  );
}

/* ─── Document row (list view) ───────────────────────────── */

interface DocRowProps {
  doc: SharedDocument;
  folders: DocumentFolder[];
  onDownload: () => void;
  onEdit: () => void;
  onMove: (folderId: number | null) => void;
  onDelete: () => void;
}

function DocRow({ doc, folders, onDownload, onEdit, onMove, onDelete }: DocRowProps) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr 90px 130px 80px 36px',
        alignItems: 'center',
        gap: 12,
        padding: '10px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        transition: 'background 0.1s',
        cursor: 'default',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.025)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    >
      {/* Type icon */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <FileTypeIcon mime={doc.mime_type} size={18} />
      </div>

      {/* Name + description */}
      <div style={{ minWidth: 0 }}>
        <button
          type="button"
          onClick={onDownload}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#e2e8f0', fontSize: '0.875rem', fontWeight: 500,
            padding: 0, textAlign: 'left', maxWidth: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            display: 'block',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#60a5fa'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#e2e8f0'; }}
        >
          {doc.original_filename}
        </button>
        {doc.description && (
          <div style={{ fontSize: '0.72rem', color: '#475569', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc.description}
          </div>
        )}
        {(doc.tags ?? []).length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
            {(doc.tags ?? []).slice(0, 3).map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.05em',
                  color: '#3b82f6', background: 'rgba(59,130,246,0.12)',
                  borderRadius: 4, padding: '1px 5px',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Size */}
      <div style={{ fontSize: '0.8rem', color: '#475569', textAlign: 'right' }}>
        {formatFileSize(doc.file_size)}
      </div>

      {/* Uploader */}
      <div style={{ fontSize: '0.8rem', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {doc.uploader_name}
      </div>

      {/* Date */}
      <div style={{ fontSize: '0.78rem', color: '#475569' }}>
        {formatDate(doc.created_at)}
      </div>

      {/* Actions */}
      <div ref={menuRef} style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
        <button
          type="button"
          onClick={() => setShowMenu((v) => !v)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#475569', borderRadius: 6, padding: '3px 4px', display: 'flex',
            transition: 'background 0.1s, color 0.1s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#94a3b8'; }}
          onMouseLeave={(e) => { if (!showMenu) { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#475569'; } }}
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

/* ─── Document card (grid view) ──────────────────────────── */

interface DocCardProps {
  doc: SharedDocument;
  folders: DocumentFolder[];
  onDownload: () => void;
  onEdit: () => void;
  onMove: (folderId: number | null) => void;
  onDelete: () => void;
}

function DocCard({ doc, folders, onDownload, onEdit, onMove, onDelete }: DocCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const isImage = doc.mime_type.startsWith('image/');
  const cat = getMimeCategory(doc.mime_type);
  const iconColor =
    cat === 'image'       ? '#a78bfa' :
    cat === 'pdf'         ? '#f87171' :
    cat === 'spreadsheet' ? '#4ade80' :
    cat === 'video'       ? '#f59e0b' :
    cat === 'audio'       ? '#38bdf8' :
    cat === 'doc'         ? '#60a5fa' :
    '#94a3b8';

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 14,
        overflow: 'hidden',
        transition: 'border-color 0.15s, background 0.15s, transform 0.12s',
        cursor: 'default',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(59,130,246,0.25)';
        (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.045)';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.07)';
        (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)';
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
      }}
    >
      {/* Preview area */}
      <div
        style={{
          height: 100,
          background: isImage
            ? 'rgba(255,255,255,0.03)'
            : `linear-gradient(135deg, ${iconColor}14 0%, transparent 100%)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          cursor: 'pointer',
          overflow: 'hidden',
        }}
        onClick={onDownload}
      >
        {isImage ? (
          <img
            src={`/api/documents/${doc.id}/download`}
            alt={doc.original_filename}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => {
              // Fallback to icon on image load failure
              const parent = e.currentTarget.parentElement;
              if (parent) {
                e.currentTarget.style.display = 'none';
              }
            }}
          />
        ) : (
          <FileTypeIcon mime={doc.mime_type} size={36} />
        )}
      </div>

      {/* Info */}
      <div style={{ padding: '12px 14px' }}>
        <button
          type="button"
          onClick={onDownload}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: '#e2e8f0', fontSize: '0.8rem', fontWeight: 600,
            padding: 0, textAlign: 'left', width: '100%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            display: 'block', marginBottom: 4,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#60a5fa'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#e2e8f0'; }}
        >
          {doc.original_filename}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.72rem', color: '#475569' }}>{formatFileSize(doc.file_size)}</span>
          <span style={{ fontSize: '0.72rem', color: '#475569' }}>{formatDate(doc.created_at)}</span>
        </div>
        {(doc.tags ?? []).length > 0 && (
          <div style={{ display: 'flex', gap: 3, marginTop: 6, flexWrap: 'wrap' }}>
            {(doc.tags ?? []).slice(0, 2).map((tag) => (
              <span
                key={tag}
                style={{
                  fontSize: '0.58rem', fontWeight: 600, letterSpacing: '0.05em',
                  color: '#3b82f6', background: 'rgba(59,130,246,0.12)',
                  borderRadius: 4, padding: '1px 5px',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Menu button */}
      <div style={{ position: 'absolute', top: 8, right: 8 }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }}
          style={{
            background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 7, cursor: 'pointer', color: '#94a3b8', display: 'flex',
            padding: '4px 5px', backdropFilter: 'blur(4px)',
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

/* ─── Empty state ────────────────────────────────────────── */

function EmptyDocState({ onUpload }: { onUpload: () => void }) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        flex: 1, gap: 16, padding: 48,
      }}
    >
      <div
        style={{
          width: 72, height: 72, borderRadius: 20,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(129,140,248,0.08) 100%)',
          border: '1px solid rgba(59,130,246,0.20)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#3b82f6',
          boxShadow: '0 0 40px rgba(59,130,246,0.10)',
        }}
      >
        <FolderOpen size={32} strokeWidth={1.4} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 300 }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#94a3b8', marginBottom: 8, letterSpacing: '-0.02em' }}>
          No documents yet
        </div>
        <div style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.65 }}>
          Upload files to share with your team. Drag and drop files anywhere on this page.
        </div>
      </div>
      <button
        type="button"
        onClick={onUpload}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 22px', borderRadius: 10,
          background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
          border: 'none', color: '#fff', fontSize: '0.875rem', fontWeight: 600,
          cursor: 'pointer', boxShadow: '0 2px 14px rgba(59,130,246,0.35)',
        }}
      >
        <Plus size={15} strokeWidth={2.5} />
        Upload files
      </button>
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────── */

const PAGE_SIZE = 40;

export function DocumentsPage() {
  /* — Folder state — */
  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);

  /* — Document state — */
  const [documents, setDocuments] = useState<SharedDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* — Stats — */
  const [stats, setStats] = useState<DocumentStats | null>(null);

  /* — Upload state — */
  const [uploadQueue, setUploadQueue] = useState<UploadProgress[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* — Modals — */
  const [editingDoc, setEditingDoc] = useState<SharedDocument | null>(null);

  /* — Page-level drag-and-drop — */
  const [pageDropOver, setPageDropOver] = useState(false);
  const dragCountRef = useRef(0);

  /* ── Data loading ───────────────────────────────────────── */

  const loadFolders = useCallback(async () => {
    try {
      const data = await listFolders();
      setFolders(data);
    } catch {
      // Non-fatal: folder tree failing shouldn't block the doc list
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const data = await getDocumentStats();
      setStats(data);
    } catch { /* non-fatal */ }
  }, []);

  const loadDocuments = useCallback(async (folderId: number | null, searchQuery: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listDocuments({
        folder_id: folderId,
        search: searchQuery || undefined,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setDocuments(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFolders();
    void loadStats();
  }, [loadFolders, loadStats]);

  useEffect(() => {
    void loadDocuments(selectedFolderId, search);
  }, [loadDocuments, selectedFolderId, search]);

  /* ── Search debounce ────────────────────────────────────── */

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = (value: string) => {
    setSearchDraft(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(value), 350);
  };

  /* ── Folder CRUD ────────────────────────────────────────── */

  const handleCreateFolder = async (name: string, parentId: number | null) => {
    try {
      await createFolder(name, parentId);
      await loadFolders();
      setShowNewFolderModal(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create folder');
    }
  };

  const handleRenameFolder = async (id: number, name: string) => {
    try {
      await renameFolder(id, name);
      await loadFolders();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to rename folder');
    }
  };

  const handleDeleteFolder = async (id: number) => {
    if (!window.confirm('Delete this folder? Documents inside will be moved to root.')) return;
    try {
      await deleteFolder(id);
      if (selectedFolderId === id) setSelectedFolderId(null);
      await loadFolders();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete folder');
    }
  };

  /* ── Upload ─────────────────────────────────────────────── */

  const handleFiles = useCallback(async (files: File[]) => {
    const entries: UploadProgress[] = files.map((f) => ({
      file: f, progress: 0, status: 'pending',
    }));
    setUploadQueue((prev) => [...prev, ...entries]);
    const startIndex = uploadQueue.length;

    await Promise.all(
      files.map(async (file, i) => {
        const queueIndex = startIndex + i;
        setUploadQueue((prev) => {
          const next = [...prev];
          next[queueIndex] = { ...next[queueIndex], status: 'uploading', progress: 0 };
          return next;
        });
        try {
          const result = await uploadDocument(
            file,
            { folder_id: selectedFolderId },
            (pct) => {
              setUploadQueue((prev) => {
                const next = [...prev];
                next[queueIndex] = { ...next[queueIndex], progress: pct };
                return next;
              });
            },
          );
          setUploadQueue((prev) => {
            const next = [...prev];
            next[queueIndex] = { ...next[queueIndex], status: 'done', progress: 100, result };
            return next;
          });
        } catch (err) {
          setUploadQueue((prev) => {
            const next = [...prev];
            next[queueIndex] = {
              ...next[queueIndex],
              status: 'error',
              error: err instanceof Error ? err.message : 'Upload failed',
            };
            return next;
          });
        }
      }),
    );

    // Refresh after all uploads settle
    await Promise.all([loadDocuments(selectedFolderId, search), loadFolders(), loadStats()]);
  }, [uploadQueue.length, selectedFolderId, search, loadDocuments, loadFolders, loadStats]);

  /* ── Page-level drag-and-drop ───────────────────────────── */

  const handlePageDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCountRef.current += 1;
    if (dragCountRef.current === 1) setPageDropOver(true);
  };

  const handlePageDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCountRef.current -= 1;
    if (dragCountRef.current === 0) setPageDropOver(false);
  };

  const handlePageDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setPageDropOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void handleFiles(files);
  };

  const handlePageDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); };

  /* ── Document CRUD ──────────────────────────────────────── */

  const handleDocEditSave = async (description: string, tags: string[]) => {
    if (!editingDoc) return;
    try {
      await updateDocument(editingDoc.id, { description, tags });
      setEditingDoc(null);
      await loadDocuments(selectedFolderId, search);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update document');
    }
  };

  const handleDocMove = async (docId: number, folderId: number | null) => {
    try {
      await updateDocument(docId, { folder_id: folderId });
      await Promise.all([loadDocuments(selectedFolderId, search), loadFolders()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to move document');
    }
  };

  const handleDocDelete = async (docId: number) => {
    if (!window.confirm('Permanently delete this document?')) return;
    try {
      await deleteDocument(docId);
      await Promise.all([loadDocuments(selectedFolderId, search), loadStats()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete document');
    }
  };

  /* ── Breadcrumb ─────────────────────────────────────────── */

  const breadcrumb = buildBreadcrumb(folders, selectedFolderId);

  /* ── Dismiss completed uploads ──────────────────────────── */

  const dismissUpload = useCallback((index: number) => {
    setUploadQueue((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div
      style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: '#0f1117' }}
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
      <style>{GLOBAL_STYLES}</style>

      {/* Page-wide drop overlay */}
      {pageDropOver && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 600,
            background: 'rgba(59,130,246,0.08)',
            border: '3px dashed rgba(59,130,246,0.40)',
            backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              background: '#1a1f2e',
              border: '1px solid rgba(59,130,246,0.40)',
              borderRadius: 20,
              padding: '28px 48px',
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 12,
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            <Upload size={36} color="#60a5fa" strokeWidth={1.5} />
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f1f5f9' }}>
              Drop files to upload
            </div>
            {selectedFolderId !== null && (
              <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                into: {folders.find((f) => f.id === selectedFolderId)?.name ?? 'selected folder'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sidebar */}
      <Sidebar />

      {/* Main content — sits to the right of the 240px sidebar */}
      <div
        style={{
          marginLeft: 240,
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          height: '100vh',
        }}
      >
        {/* ── Left panel: folder tree (280px) ─────────────── */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#0c0e16',
          }}
        >
          {/* Folder panel header */}
          <div
            style={{
              padding: '18px 16px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Folders
            </span>
            <button
              type="button"
              onClick={() => setShowNewFolderModal(true)}
              title="New folder"
              style={{
                background: 'rgba(59,130,246,0.12)',
                border: '1px solid rgba(59,130,246,0.25)',
                borderRadius: 7,
                cursor: 'pointer',
                color: '#60a5fa',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 9px',
                fontSize: '0.72rem',
                fontWeight: 600,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.20)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.12)'; }}
            >
              <FolderPlus size={13} strokeWidth={2} />
              New
            </button>
          </div>

          {/* Folder list — scrollable */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
            {/* All Documents root item */}
            <div
              onClick={() => setSelectedFolderId(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
                background: selectedFolderId === null
                  ? 'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(59,130,246,0.08) 100%)'
                  : 'transparent',
                color: selectedFolderId === null ? '#93c5fd' : '#64748b',
                transition: 'background 0.12s, color 0.12s',
                userSelect: 'none',
                marginBottom: 2,
              }}
              onMouseEnter={(e) => {
                if (selectedFolderId !== null) {
                  (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)';
                  (e.currentTarget as HTMLDivElement).style.color = '#94a3b8';
                }
              }}
              onMouseLeave={(e) => {
                if (selectedFolderId !== null) {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  (e.currentTarget as HTMLDivElement).style.color = '#64748b';
                }
              }}
            >
              {selectedFolderId === null
                ? <FolderOpen size={15} color="#60a5fa" strokeWidth={1.8} />
                : <Folder size={15} strokeWidth={1.8} />}
              <span style={{ fontSize: '0.825rem', fontWeight: selectedFolderId === null ? 700 : 500, color: selectedFolderId === null ? '#e2e8f0' : 'inherit' }}>
                All Documents
              </span>
              {stats && (
                <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#475569', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px' }}>
                  {stats.total_documents}
                </span>
              )}
            </div>

            {/* Folder tree */}
            <FolderTree
              folders={folders}
              selectedId={selectedFolderId}
              onSelect={setSelectedFolderId}
              onRename={handleRenameFolder}
              onDelete={handleDeleteFolder}
            />
          </div>
        </div>

        {/* ── Right panel: header + doc list ──────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>

          {/* ── Top header bar ─────────────────────────────── */}
          <div
            style={{
              padding: '14px 24px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexShrink: 0,
              background: '#0f1117',
            }}
          >
            {/* Breadcrumb */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setSelectedFolderId(null)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: selectedFolderId === null ? '#e2e8f0' : '#475569',
                  fontSize: '0.875rem', fontWeight: selectedFolderId === null ? 700 : 500,
                  padding: 0, display: 'flex', alignItems: 'center', gap: 6,
                  transition: 'color 0.12s',
                }}
                onMouseEnter={(e) => { if (selectedFolderId !== null) e.currentTarget.style.color = '#94a3b8'; }}
                onMouseLeave={(e) => { if (selectedFolderId !== null) e.currentTarget.style.color = '#475569'; }}
              >
                <FolderOpen size={15} strokeWidth={1.8} color={selectedFolderId === null ? '#60a5fa' : 'inherit'} />
                All Documents
              </button>
              {breadcrumb.map((folder) => (
                <div key={folder.id} style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                  <ChevronRight size={13} color="#334155" strokeWidth={2.5} />
                  <button
                    type="button"
                    onClick={() => setSelectedFolderId(folder.id)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: selectedFolderId === folder.id ? '#e2e8f0' : '#475569',
                      fontSize: '0.875rem', fontWeight: selectedFolderId === folder.id ? 700 : 500,
                      padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {folder.name}
                  </button>
                </div>
              ))}
            </div>

            {/* Stats */}
            <StatsBar stats={stats} />

            {/* Search */}
            <div style={{ position: 'relative', width: 220 }}>
              <Search size={14} color="#475569" strokeWidth={2} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
              <input
                value={searchDraft}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search documents…"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 9, color: '#e2e8f0',
                  fontSize: '0.825rem', padding: '8px 12px 8px 32px',
                  outline: 'none',
                  transition: 'border-color 0.15s',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.40)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
              />
            </div>

            {/* View toggle */}
            <div style={{ display: 'flex', background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: 3, gap: 2, flexShrink: 0 }}>
              {(['list', 'grid'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  style={{
                    background: viewMode === mode ? 'rgba(255,255,255,0.09)' : 'transparent',
                    border: viewMode === mode ? '1px solid rgba(255,255,255,0.10)' : '1px solid transparent',
                    borderRadius: 6, cursor: 'pointer', padding: '5px 8px',
                    color: viewMode === mode ? '#e2e8f0' : '#475569',
                    display: 'flex', alignItems: 'center',
                    transition: 'background 0.12s, color 0.12s',
                  }}
                >
                  {mode === 'list' ? <List size={15} strokeWidth={2} /> : <Grid size={15} strokeWidth={2} />}
                </button>
              ))}
            </div>

            {/* Upload button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '9px 18px', borderRadius: 9,
                background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
                border: 'none', color: '#fff', fontSize: '0.875rem', fontWeight: 600,
                cursor: 'pointer', flexShrink: 0,
                boxShadow: '0 2px 12px rgba(59,130,246,0.35)',
                transition: 'opacity 0.15s, transform 0.12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.88'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <Upload size={15} strokeWidth={2.5} />
              Upload
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) void handleFiles(files);
                e.target.value = '';
              }}
            />
          </div>

          {/* ── Document list area (scrollable) ─────────────── */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

            {/* Loading spinner */}
            {isLoading && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
                <div
                  style={{
                    width: 32, height: 32, borderRadius: '50%',
                    border: '3px solid rgba(255,255,255,0.08)',
                    borderTopColor: '#3b82f6',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              </div>
            )}

            {/* Error state */}
            {!isLoading && error && (
              <div style={{ padding: 32, textAlign: 'center' }}>
                <div style={{ color: '#f87171', fontSize: '0.875rem', marginBottom: 12 }}>{error}</div>
                <button
                  type="button"
                  onClick={() => void loadDocuments(selectedFolderId, search)}
                  style={{
                    padding: '8px 18px', borderRadius: 8,
                    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
                    color: '#94a3b8', fontSize: '0.8rem', cursor: 'pointer',
                  }}
                >
                  Try again
                </button>
              </div>
            )}

            {/* Document list — list view */}
            {!isLoading && !error && documents.length > 0 && viewMode === 'list' && (
              <>
                {/* Column header */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '32px 1fr 90px 130px 80px 36px',
                    gap: 12,
                    padding: '8px 20px',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    flexShrink: 0,
                  }}
                >
                  {['', 'Name', 'Size', 'Uploaded by', 'Date', ''].map((col, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: '0.65rem', fontWeight: 700, color: '#334155',
                        textTransform: 'uppercase', letterSpacing: '0.10em',
                        textAlign: i === 2 ? 'right' : 'left',
                      }}
                    >
                      {col}
                    </div>
                  ))}
                </div>
                {documents.map((doc) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    folders={folders}
                    onDownload={() => downloadDocument(doc.id)}
                    onEdit={() => setEditingDoc(doc)}
                    onMove={(folderId) => void handleDocMove(doc.id, folderId)}
                    onDelete={() => void handleDocDelete(doc.id)}
                  />
                ))}
                {total > documents.length && (
                  <div style={{ padding: '16px 20px', textAlign: 'center', color: '#334155', fontSize: '0.78rem' }}>
                    Showing {documents.length} of {total} documents
                  </div>
                )}
              </>
            )}

            {/* Document list — grid view */}
            {!isLoading && !error && documents.length > 0 && viewMode === 'grid' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: 14,
                  padding: 24,
                }}
              >
                {documents.map((doc) => (
                  <DocCard
                    key={doc.id}
                    doc={doc}
                    folders={folders}
                    onDownload={() => downloadDocument(doc.id)}
                    onEdit={() => setEditingDoc(doc)}
                    onMove={(folderId) => void handleDocMove(doc.id, folderId)}
                    onDelete={() => void handleDocDelete(doc.id)}
                  />
                ))}
              </div>
            )}

            {/* Empty state */}
            {!isLoading && !error && documents.length === 0 && (
              <EmptyDocState onUpload={() => fileInputRef.current?.click()} />
            )}

            {/* Drop zone — always visible at bottom (gives a clear upload target) */}
            {!isLoading && (
              <DropZone onFiles={(files) => void handleFiles(files)} />
            )}
          </div>
        </div>
      </div>

      {/* Softphone overlay */}
      <SoftphoneWidget />

      {/* Upload progress toasts */}
      <UploadQueue queue={uploadQueue} onDismiss={dismissUpload} />

      {/* Edit description modal */}
      {editingDoc && (
        <EditDescModal
          doc={editingDoc}
          onSave={(desc, tags) => void handleDocEditSave(desc, tags)}
          onClose={() => setEditingDoc(null)}
        />
      )}

      {/* New folder modal */}
      {showNewFolderModal && (
        <NewFolderModal
          parentId={selectedFolderId}
          folders={folders}
          onSave={(name, parentId) => void handleCreateFolder(name, parentId)}
          onClose={() => setShowNewFolderModal(false)}
        />
      )}
    </div>
  );
}
