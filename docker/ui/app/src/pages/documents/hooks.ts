/**
 * Data + logic layer for the Documents page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level UI state only; ALL data fetching, uploads, folder /
 * document mutations, and derived state live here in one controller hook. The
 * imperative load/upload behaviour is preserved exactly from the original
 * monofile (multi-file progress, client-side validation, optimistic queue).
 *
 * React #310: every hook below is called unconditionally at the top.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  listDocuments,
  uploadDocument,
  updateDocument,
  deleteDocument,
  getDocumentStats,
} from '../../api/documents';
import {
  validateUpload,
  DOCUMENT_UPLOAD_CONSTRAINTS,
} from '../../lib/uploadValidation';
import type {
  DocumentFolder,
  SharedDocument,
  DocumentStats,
  UploadProgress,
} from '../../types/documents';
import { PAGE_SIZE } from './types';
import { buildBreadcrumb } from './helpers';

export interface UseDocumentsResult {
  /* folders */
  folders: DocumentFolder[];
  selectedFolderId: number | null;
  setSelectedFolderId: (id: number | null) => void;
  breadcrumb: DocumentFolder[];
  /* documents */
  documents: SharedDocument[];
  total: number;
  isLoading: boolean;
  error: string | null;
  reloadDocuments: () => void;
  /* stats */
  stats: DocumentStats | null;
  /* search */
  searchDraft: string;
  handleSearchChange: (value: string) => void;
  /* uploads */
  uploadQueue: UploadProgress[];
  uploadFiles: (files: File[]) => Promise<void>;
  dismissUpload: (index: number) => void;
  /* folder CRUD */
  createFolderAction: (name: string, parentId: number | null) => Promise<boolean>;
  renameFolderAction: (id: number, name: string) => Promise<void>;
  deleteFolderAction: (id: number) => Promise<void>;
  /* document CRUD */
  updateDocMeta: (docId: number, description: string, tags: string[]) => Promise<boolean>;
  moveDoc: (docId: number, folderId: number | null) => Promise<void>;
  deleteDoc: (docId: number) => Promise<void>;
}

export function useDocuments(): UseDocumentsResult {
  /* — Folder state — */
  const [folders, setFolders] = useState<DocumentFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);

  /* — Document state — */
  const [documents, setDocuments] = useState<SharedDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* — Stats — */
  const [stats, setStats] = useState<DocumentStats | null>(null);

  /* — Upload state — */
  const [uploadQueue, setUploadQueue] = useState<UploadProgress[]>([]);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleSearchChange = useCallback((value: string) => {
    setSearchDraft(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(value), 350);
  }, []);

  /* ── Folder CRUD ────────────────────────────────────────── */

  const createFolderAction = useCallback(async (name: string, parentId: number | null): Promise<boolean> => {
    try {
      await createFolder(name, parentId);
      await loadFolders();
      return true;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create folder');
      return false;
    }
  }, [loadFolders]);

  const renameFolderAction = useCallback(async (id: number, name: string) => {
    try {
      await renameFolder(id, name);
      await loadFolders();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to rename folder');
    }
  }, [loadFolders]);

  const deleteFolderAction = useCallback(async (id: number) => {
    if (!window.confirm('Delete this folder? Documents inside will be moved to root.')) return;
    try {
      await deleteFolder(id);
      if (selectedFolderId === id) setSelectedFolderId(null);
      await loadFolders();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete folder');
    }
  }, [loadFolders, selectedFolderId]);

  /* ── Upload ─────────────────────────────────────────────── */

  const uploadFiles = useCallback(async (files: File[]) => {
    // Validate every file up front. Invalid files enter the queue already in the
    // 'error' state with a clear message and are never sent to the server — this
    // is the inline, before-upload UX guard (the server still re-validates).
    const entries: UploadProgress[] = files.map((f) => {
      const validation = validateUpload(f, DOCUMENT_UPLOAD_CONSTRAINTS);
      return validation.ok
        ? { file: f, progress: 0, status: 'pending' as const }
        : { file: f, progress: 0, status: 'error' as const, error: validation.error };
    });
    setUploadQueue((prev) => [...prev, ...entries]);
    const startIndex = uploadQueue.length;

    await Promise.all(
      files.map(async (file, i) => {
        const queueIndex = startIndex + i;
        // Skip files that failed client-side validation — already marked 'error'.
        if (entries[i].status === 'error') return;
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

  const dismissUpload = useCallback((index: number) => {
    setUploadQueue((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /* ── Document CRUD ──────────────────────────────────────── */

  const updateDocMeta = useCallback(async (docId: number, description: string, tags: string[]): Promise<boolean> => {
    try {
      await updateDocument(docId, { description, tags });
      await loadDocuments(selectedFolderId, search);
      return true;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update document');
      return false;
    }
  }, [loadDocuments, selectedFolderId, search]);

  const moveDoc = useCallback(async (docId: number, folderId: number | null) => {
    try {
      await updateDocument(docId, { folder_id: folderId });
      await Promise.all([loadDocuments(selectedFolderId, search), loadFolders()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to move document');
    }
  }, [loadDocuments, loadFolders, selectedFolderId, search]);

  const deleteDoc = useCallback(async (docId: number) => {
    if (!window.confirm('Permanently delete this document?')) return;
    try {
      await deleteDocument(docId);
      await Promise.all([loadDocuments(selectedFolderId, search), loadStats()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete document');
    }
  }, [loadDocuments, loadStats, selectedFolderId, search]);

  const reloadDocuments = useCallback(() => {
    void loadDocuments(selectedFolderId, search);
  }, [loadDocuments, selectedFolderId, search]);

  const breadcrumb = buildBreadcrumb(folders, selectedFolderId);

  return {
    folders,
    selectedFolderId,
    setSelectedFolderId,
    breadcrumb,
    documents,
    total,
    isLoading,
    error,
    reloadDocuments,
    stats,
    searchDraft,
    handleSearchChange,
    uploadQueue,
    uploadFiles,
    dismissUpload,
    createFolderAction,
    renameFolderAction,
    deleteFolderAction,
    updateDocMeta,
    moveDoc,
    deleteDoc,
  };
}
