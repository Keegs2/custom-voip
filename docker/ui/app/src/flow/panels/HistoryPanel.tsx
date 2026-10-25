/**
 * HistoryPanel — published versions, newest first (contract §8.2).
 *
 *   View     shows that version on the canvas, READ-ONLY, in place of the
 *            draft (the draft is untouched — the old History "View" wrote
 *            over the canvas and could spawn a duplicate flow).
 *   Restore  after a confirmation, copies the version into the DRAFT on the
 *            server (`…/restore` with the current revision). Nothing is
 *            published; it can be undone like any edit.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, History, RotateCcw } from 'lucide-react';
import { getFlowVersion, restoreFlowVersion } from '../../api/ivr';
import type { FlowVersion } from '../../types/ivr';
import { useToast } from '../../components/ui/ToastContext';
import { ConfirmDialog } from '../../pages/voicemail/VmDialog';
import { formatWhen } from '../../pages/ivr/format';
import { invalidateIvr, isIvrError, ivrErrorText, ivrKeys, useFlowVersions } from '../../pages/ivr/ivrData';
import { useIvrWorkspace } from '../../pages/ivr/IvrContext';
import { previewFromGraph, useFlow, useFlowStoreApi } from '../store/flowStore';
import { useBuilderData } from '../BuilderData';
import { SideSheet } from './SideSheet';

export interface HistoryPanelProps {
  flush: () => Promise<boolean>;
  onClose: () => void;
  onConflict: () => void;
}

export function HistoryPanel({ flush, onClose, onConflict }: HistoryPanelProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const store = useFlowStoreApi();
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const { readOnly } = useBuilderData();
  const meta = useFlow((s) => s.meta);
  const preview = useFlow((s) => s.preview);
  const versions = useFlowVersions(ws.scope, meta.id);
  const [loadingView, setLoadingView] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<FlowVersion | null>(null);

  const restore = useMutation({
    mutationFn: async (v: FlowVersion) => {
      const saved = await flush();
      if (!saved) throw new Error('unsaved');
      return restoreFlowVersion(meta.id, v.version, store.getState().revision, ws.scope.customerId);
    },
    onSuccess: (flow, v) => {
      store.getState().load(flow, { undoable: true });
      queryClient.setQueryData(ivrKeys.flow(ws.scope, flow.id), flow);
      void invalidateIvr(queryClient, ws.scope);
      setConfirm(null);
      toastOk(
        meta.publishedVersion
          ? `Version ${v.version} is now your draft. Callers still hear version ${meta.publishedVersion} until you publish.`
          : `Version ${v.version} is now your draft.`,
      );
      onClose();
    },
    onError: (err) => {
      if (isIvrError(err, 409, 'stale_revision')) {
        setConfirm(null);
        onConflict();
      }
    },
  });

  const view = async (v: FlowVersion) => {
    setLoadingView(v.version);
    try {
      const detail = await queryClient.fetchQuery({
        queryKey: ivrKeys.version(ws.scope, meta.id, v.version),
        queryFn: () => getFlowVersion(meta.id, v.version, ws.scope.customerId),
        staleTime: Infinity,
      });
      store.getState().enterPreview(previewFromGraph(detail.version, detail.published_at, detail.graph));
    } catch (err) {
      toastErr(ivrErrorText(err, 'That version couldn’t be loaded.'));
    } finally {
      setLoadingView(null);
    }
  };

  const list = [...(versions.data ?? [])].sort((a, b) => b.version - a.version);

  return (
    <SideSheet
      title="Version history"
      sub="Every published version is kept. View one, or copy it back into your draft."
      icon={<History size={16} aria-hidden="true" />}
      onClose={() => {
        store.getState().exitPreview();
        onClose();
      }}
    >
      {versions.isLoading ? (
        <p className="ivr-state" role="status">
          <span className="vm-spin" aria-hidden="true" /> Loading versions…
        </p>
      ) : versions.isError ? (
        <div className="dl-banner dl-banner-err">{ivrErrorText(versions.error, 'Versions couldn’t be loaded.')}</div>
      ) : list.length === 0 ? (
        <div className="ivr-empty">
          <span className="ivr-empty-icon" aria-hidden="true">
            <History size={18} />
          </span>
          <div>
            <p className="ivr-empty-title">Not published yet</p>
            <p className="ivr-empty-copy">Each time you publish, the version callers hear is saved here.</p>
          </div>
        </div>
      ) : (
        <ol className="ivr-versions">
          {list.map((v) => {
            const isLive = v.version === meta.publishedVersion;
            const viewing = preview?.version === v.version;
            return (
              <li key={v.version} className={`ivr-version${viewing ? ' ivr-version-on' : ''}`}>
                <div className="ivr-version-id">
                  <span className="ivr-version-n">Version {v.version}</span>
                  {isLive && <span className="ivr-tag ivr-tag-ok">Live</span>}
                  {viewing && <span className="ivr-tag">On screen</span>}
                </div>
                <p className="ivr-version-meta">
                  Published {formatWhen(v.published_at)}
                  {v.published_by_email ? ` by ${v.published_by_email}` : ''}
                </p>
                <div className="ivr-version-actions">
                  {viewing ? (
                    <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={() => store.getState().exitPreview()}>
                      Back to your draft
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="dl-btn dl-btn-ghost ivr-btn-sm"
                      onClick={() => void view(v)}
                      disabled={loadingView !== null}
                    >
                      {loadingView === v.version ? <span className="vm-spin" aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                      View
                    </button>
                  )}
                  {!readOnly && (
                    <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={() => setConfirm(v)}>
                      <RotateCcw size={13} aria-hidden="true" /> Restore to draft
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {confirm && (
        <ConfirmDialog
          title={`Restore version ${confirm.version} into your draft?`}
          body={
            <>
              <p>Your current draft is replaced by version {confirm.version}. You can undo this in the builder.</p>
              <p>
                {meta.publishedVersion
                  ? `Callers keep hearing version ${meta.publishedVersion} until you publish.`
                  : 'Nothing is published until you publish.'}
              </p>
            </>
          }
          confirmLabel="Restore to draft"
          pending={restore.isPending}
          error={
            restore.isError && !isIvrError(restore.error, 409, 'stale_revision')
              ? restore.error instanceof Error && restore.error.message === 'unsaved'
                ? 'Your latest changes aren’t saved yet. Wait a moment and try again.'
                : ivrErrorText(restore.error, 'The version couldn’t be restored. Try again.')
              : null
          }
          onConfirm={() => restore.mutate(confirm)}
          onCancel={() => {
            restore.reset();
            setConfirm(null);
          }}
        />
      )}
    </SideSheet>
  );
}
