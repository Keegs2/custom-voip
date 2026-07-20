/**
 * Version-history modal for the Call Flow Builder.
 *
 * Lists a saved flow's published versions (newest first) and lets an admin:
 *   • View    — loads that version's `flow_graph` into the canvas (preview).
 *   • Restore — clones the version into a fresh draft (backend), loads it, and
 *               invalidates the versions query. Guarded by an inline confirm
 *               because it replaces the working canvas.
 *
 * React #310: ALL hooks (store selectors, query, mutations, local state) are
 * declared unconditionally at the top, before any early return. The versions
 * query is gated with `enabled` rather than a conditional hook call.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFlowStore } from '../store/flowStore';
import {
  getFlowVersion,
  listFlowVersions,
  restoreFlowVersion,
} from '../../api/callFlows';
import type { CallFlow, FlowVersionDetail } from '../../types/callFlow';
import type { CallFlowDoc } from '../model/types';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { CenteredSpinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import { ApiError } from '../../api/client';

interface FlowHistoryModalProps {
  open: boolean;
  onClose: () => void;
  /** Saved flow id. Null when the current flow has never been saved. */
  flowId: number | null;
}

/** React Query key for a flow's version list (invalidate after restore).
 *  Module-private: nothing imports it, and exporting a non-component from a
 *  component file breaks fast refresh (react-refresh/only-export-components). */
function flowVersionsKey(flowId: number) {
  return ['call-flow-versions', flowId] as const;
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function FlowHistoryModal({ open, onClose, flowId }: FlowHistoryModalProps) {
  // ── Hooks (all unconditional, top of component) ──────────────────────────
  const loadDoc = useFlowStore((s) => s.loadDoc);
  const patchDoc = useFlowStore((s) => s.patchDoc);
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  // Pending restore awaiting confirmation (replaces the working canvas).
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: flowVersionsKey(flowId ?? 0),
    queryFn: () => listFlowVersions(flowId as number),
    enabled: open && flowId != null,
  });

  const viewMutation = useMutation({
    mutationFn: (version: number): Promise<FlowVersionDetail> =>
      getFlowVersion(flowId as number, version),
    onSuccess: (detail) => {
      // Load the historical graph onto the canvas as a preview. It carries its
      // own id/product/name/status, so loadDoc fully reconstructs it.
      loadDoc(detail.flow_graph as CallFlowDoc);
      toastOk(`Viewing version #${detail.version}`);
      onClose();
    },
    onError: (e) =>
      toastErr(e instanceof ApiError ? e.message : 'Failed to load version'),
  });

  const restoreMutation = useMutation({
    mutationFn: (version: number): Promise<CallFlow> =>
      restoreFlowVersion(flowId as number, version),
    onSuccess: (flow) => {
      // The restored draft becomes the working document.
      loadDoc(flow.flow_graph as CallFlowDoc);
      patchDoc({
        id: flow.id,
        product: flow.product,
        name: flow.name,
        status: flow.status,
        version: flow.version,
        customerId: flow.customer_id,
        entry: flow.entry,
      });
      setConfirmVersion(null);
      if (flowId != null) {
        queryClient.invalidateQueries({ queryKey: flowVersionsKey(flowId) });
      }
      toastOk(`Restored to a new draft from version #${confirmVersion ?? flow.version}`);
      onClose();
    },
    onError: (e) =>
      toastErr(e instanceof ApiError ? e.message : 'Restore failed'),
  });

  // Derived (no hooks) — safe after the hooks above.
  const items = versionsQuery.data?.items ?? [];
  // Defensive: present newest-first even if the backend order ever drifts.
  const versions = [...items].sort((a, b) => b.version - a.version);
  const busy = viewMutation.isPending || restoreMutation.isPending;

  return (
    <Modal open={open} onClose={onClose} title="Version history" maxWidth="max-w-xl">
      {flowId == null ? (
        <EmptyHint text="Save this flow before you can view its version history." />
      ) : versionsQuery.isLoading ? (
        <CenteredSpinner label="Loading versions…" />
      ) : versionsQuery.isError ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
          <p style={{ margin: 0, fontSize: '0.8rem', color: '#fca5a5' }}>
            {versionsQuery.error instanceof ApiError
              ? versionsQuery.error.message
              : 'Failed to load version history.'}
          </p>
          <Button variant="ghost" size="sm" onClick={() => versionsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : versions.length === 0 ? (
        <EmptyHint text="No published versions yet. Publishing a flow snapshots it here." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {versions.map((v) => {
            const isConfirming = confirmVersion === v.version;
            const isRestoring =
              restoreMutation.isPending && restoreMutation.variables === v.version;
            const isViewing =
              viewMutation.isPending && viewMutation.variables === v.version;
            return (
              <div
                key={v.version}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'rgba(26,29,39,0.9)',
                  border: `1px solid ${isConfirming ? 'rgba(245,158,11,0.5)' : 'rgba(42,47,69,0.8)'}`,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#e2e8f0' }}>
                    Version #{v.version}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                    Published {formatStamp(v.published_at)}
                  </span>
                </div>

                {isConfirming ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '0.72rem', color: '#fbbf24' }}>
                      Replace canvas?
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setConfirmVersion(null)}
                      disabled={isRestoring}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="success"
                      size="xs"
                      loading={isRestoring}
                      onClick={() => restoreMutation.mutate(v.version)}
                    >
                      Confirm restore
                    </Button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Button
                      variant="ghost"
                      size="xs"
                      loading={isViewing}
                      disabled={busy}
                      onClick={() => viewMutation.mutate(v.version)}
                    >
                      View
                    </Button>
                    <Button
                      variant="primary"
                      size="xs"
                      disabled={busy}
                      onClick={() => setConfirmVersion(v.version)}
                    >
                      Restore
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 16px',
        textAlign: 'center',
        fontSize: '0.8rem',
        color: '#718096',
      }}
    >
      {text}
    </div>
  );
}
