/**
 * DocumentsPage — full-screen shared document library (liquid-glass, blue).
 *
 * This is the THIN routed page: composition + top-level UI state only. All data
 * fetching, uploads, and folder/document mutations live in `documents/hooks.ts`;
 * presentational pieces in `documents/components/`; styles in `documents/styles.ts`.
 * See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * Layout:  Sidebar | 280px folder rail | main panel (header + list/grid + upload)
 *
 * This route renders its OWN Sidebar + SoftphoneWidget OUTSIDE AppLayout, so it
 * is NOT on the app-wide GlassBackground — it mounts its own (the documented
 * full-screen exception).
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useRef, useState, type DragEvent } from 'react';
import { Upload } from 'lucide-react';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import { GlassBackground } from '../components/glass/GlassBackground';
import { GlassSheen } from '../components/glass/GlassCard';
import { GLASS } from '../components/glass/glass';
import { downloadDocument } from '../api/documents';
import type { SharedDocument } from '../types/documents';
import { useDocuments } from './documents/hooks';
import type { ViewMode } from './documents/types';
import {
  contentShell,
  glassColumn,
  listHeader,
  listHeaderCell,
  cardGrid,
  dropOverlay,
} from './documents/styles';
import { FolderRail } from './documents/components/FolderRail';
import { DocumentsHeader } from './documents/components/DocumentsHeader';
import { DocRow } from './documents/components/DocRow';
import { DocCard } from './documents/components/DocCard';
import { DropZone } from './documents/components/DropZone';
import { UploadQueue } from './documents/components/UploadQueue';
import { LoadingState, ErrorState, EmptyDocState } from './documents/components/states';
import { EditDescModal } from './documents/components/EditDescModal';
import { NewFolderModal } from './documents/components/NewFolderModal';

/* Local keyframes not provided by GlassBackground (glass-spin IS provided). */
const LOCAL_KEYFRAMES = `
  @keyframes docFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes progressPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
`;

const LIST_COLS = ['', 'Name', 'Size', 'Uploaded by', 'Date', ''];

export function DocumentsPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const doc = useDocuments();

  const [view, setView] = useState<ViewMode>('list');
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [editingDoc, setEditingDoc] = useState<SharedDocument | null>(null);
  const [pageDropOver, setPageDropOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCountRef = useRef(0);

  // ── Page-level drag-and-drop ──────────────────────────────────────────────
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
    if (files.length > 0) void doc.uploadFiles(files);
  };
  const handlePageDragOver = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); };

  const openUploadPicker = () => fileInputRef.current?.click();

  const hasDocs = doc.documents.length > 0;
  const showData = !doc.isLoading && !doc.error;

  return (
    <div
      className="min-h-screen"
      style={{ position: 'relative', minHeight: '100vh' }}
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
      <style>{LOCAL_KEYFRAMES}</style>

      {/* Ambient liquid-glass field (this route is outside AppLayout) */}
      <GlassBackground />

      {/* Page-wide drop overlay */}
      {pageDropOver && (
        <div style={dropOverlay}>
          <div style={{ ...glassColumn(), height: 'auto', alignItems: 'center', padding: '28px 48px', gap: 12, borderRadius: 20 }}>
            <GlassSheen />
            <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <Upload size={36} color={GLASS.accent} strokeWidth={1.5} />
              <div style={{ fontSize: '1rem', fontWeight: 700, color: GLASS.text }}>Drop files to upload</div>
              {doc.selectedFolderId !== null && (
                <div style={{ fontSize: '0.8rem', color: GLASS.textMuted }}>
                  into: {doc.folders.find((f) => f.id === doc.selectedFolderId)?.name ?? 'selected folder'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <Sidebar />

      {/* Content — floats the rail + main panel over the glass backdrop.
          sidebar-offset = the 240px sidebar offset, applied ONLY at md+ (below md
          the Sidebar is off-canvas; see contentShell's note in styles.ts). */}
      <div className="sidebar-offset" style={contentShell}>
        {/* Left: folder rail */}
        <FolderRail
          folders={doc.folders}
          selectedFolderId={doc.selectedFolderId}
          stats={doc.stats}
          onSelect={doc.setSelectedFolderId}
          onNewFolder={() => setShowNewFolderModal(true)}
          onRename={(id, name) => void doc.renameFolderAction(id, name)}
          onDelete={(id) => void doc.deleteFolderAction(id)}
        />

        {/* Right: main panel */}
        <div style={glassColumn({ flex: 1, minWidth: 0 })}>
          <GlassSheen />

          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <DocumentsHeader
              breadcrumb={doc.breadcrumb}
              selectedFolderId={doc.selectedFolderId}
              onSelectFolder={doc.setSelectedFolderId}
              stats={doc.stats}
              searchDraft={doc.searchDraft}
              onSearch={doc.handleSearchChange}
              view={view}
              onView={setView}
              onUpload={openUploadPicker}
            />

            {/* Document list area (scrollable) */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              {doc.isLoading && <LoadingState />}

              {!doc.isLoading && doc.error && (
                <ErrorState message={doc.error} onRetry={doc.reloadDocuments} />
              )}

              {/* List view */}
              {showData && hasDocs && view === 'list' && (
                <>
                  <div style={listHeader}>
                    {LIST_COLS.map((col, i) => (
                      <div key={i} style={listHeaderCell(i === 2)}>{col}</div>
                    ))}
                  </div>
                  {doc.documents.map((d) => (
                    <DocRow
                      key={d.id}
                      doc={d}
                      folders={doc.folders}
                      onDownload={() => downloadDocument(d.id, d.original_filename)}
                      onEdit={() => setEditingDoc(d)}
                      onMove={(folderId) => void doc.moveDoc(d.id, folderId)}
                      onDelete={() => void doc.deleteDoc(d.id)}
                    />
                  ))}
                  {doc.total > doc.documents.length && (
                    <div style={{ padding: '16px 22px', textAlign: 'center', color: GLASS.textFaint, fontSize: '0.78rem' }}>
                      Showing {doc.documents.length} of {doc.total} documents
                    </div>
                  )}
                </>
              )}

              {/* Grid view */}
              {showData && hasDocs && view === 'grid' && (
                <div style={cardGrid}>
                  {doc.documents.map((d) => (
                    <DocCard
                      key={d.id}
                      doc={d}
                      folders={doc.folders}
                      onDownload={() => downloadDocument(d.id, d.original_filename)}
                      onEdit={() => setEditingDoc(d)}
                      onMove={(folderId) => void doc.moveDoc(d.id, folderId)}
                      onDelete={() => void doc.deleteDoc(d.id)}
                    />
                  ))}
                </div>
              )}

              {/* Empty state */}
              {showData && !hasDocs && <EmptyDocState onUpload={openUploadPicker} />}

              {/* Drop zone — always visible at bottom */}
              {!doc.isLoading && <DropZone onFiles={(files) => void doc.uploadFiles(files)} />}
            </div>
          </div>
        </div>
      </div>

      {/* Hidden file input for the Upload button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void doc.uploadFiles(files);
          e.target.value = '';
        }}
      />

      {/* Softphone overlay */}
      <SoftphoneWidget />

      {/* Upload progress toasts */}
      <UploadQueue queue={doc.uploadQueue} onDismiss={doc.dismissUpload} />

      {/* Edit description modal */}
      {editingDoc && (
        <EditDescModal
          doc={editingDoc}
          onSave={async (desc, tags) => {
            const ok = await doc.updateDocMeta(editingDoc.id, desc, tags);
            if (ok) setEditingDoc(null);
          }}
          onClose={() => setEditingDoc(null)}
        />
      )}

      {/* New folder modal */}
      {showNewFolderModal && (
        <NewFolderModal
          parentId={doc.selectedFolderId}
          folders={doc.folders}
          onSave={async (name, parentId) => {
            const ok = await doc.createFolderAction(name, parentId);
            if (ok) setShowNewFolderModal(false);
          }}
          onClose={() => setShowNewFolderModal(false)}
        />
      )}
    </div>
  );
}
