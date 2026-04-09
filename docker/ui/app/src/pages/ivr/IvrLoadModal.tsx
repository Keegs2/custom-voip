/**
 * IVR Builder — Load Flow Modal
 *
 * Fetches the list of saved flows and lets the user load or delete one.
 */

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { listIvrFlows, getIvrFlow, deleteIvrFlow } from '../../api/ivr';
import type { IvrFlowListItem } from '../../types/ivr';
import type { IvrFlowState } from './useIvrFlow';
import type { BuilderNode } from './ivrUtils';

interface IvrLoadModalProps {
  open: boolean;
  onClose: () => void;
  onLoad: (state: IvrFlowState) => void;
  currentFlowId: number | null;
}

export function IvrLoadModal({ open, onClose, onLoad, currentFlowId }: IvrLoadModalProps) {
  const [flows, setFlows] = useState<IvrFlowListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);

  const fetchFlows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listIvrFlows();
      setFlows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load flows');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch whenever the modal opens
  useEffect(() => {
    if (open) {
      void fetchFlows();
    }
  }, [open, fetchFlows]);

  async function handleLoad(id: number) {
    setLoadingId(id);
    try {
      const flow = await getIvrFlow(id);
      // Map the API node shape to BuilderNode (add prompt/branches arrays)
      const buildNodes = (rawNodes: typeof flow.nodes): BuilderNode[] =>
        rawNodes.map((n) => ({
          id: n.id,
          type: n.type,
          config: n.config as Record<string, string>,
          prompt: [],
          branches: {},
          _activeBranch: null,
        }));

      const state: IvrFlowState = {
        id: flow.id,
        name: flow.name,
        customerId: null,
        did: flow.did ?? null,
        nodes: buildNodes(flow.nodes),
        selectedNodeId: null,
      };

      onLoad(state);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load flow');
    } finally {
      setLoadingId(null);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this flow? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      await deleteIvrFlow(id);
      // Remove from list locally — if we just deleted the current flow, reset state elsewhere
      setFlows((prev) => prev.filter((f) => f.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete flow');
    } finally {
      setDeletingId(null);
    }
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch {
      return iso;
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Load IVR Flow" maxWidth="max-w-xl">
      {loading ? (
        <div className="flex items-center justify-center py-10 gap-3">
          <Spinner size="sm" />
          <span className="text-[#718096] text-sm">Loading flows...</span>
        </div>
      ) : error ? (
        <div className="text-center py-8">
          <p className="text-[#fca5a5] text-sm mb-3">{error}</p>
          <button
            type="button"
            onClick={() => void fetchFlows()}
            className="text-sm text-[#3b82f6] hover:underline"
          >
            Retry
          </button>
        </div>
      ) : flows.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-[#4a5568] text-sm font-medium mb-1">No saved flows</p>
          <p className="text-[#3d4460] text-xs">Save a flow first, then come back here to load it.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {flows.map((flow) => (
            <div
              key={flow.id}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
                flow.id === currentFlowId
                  ? 'border-[#3b82f6]/40 bg-[#3b82f6]/8'
                  : 'border-[#2a2f45] bg-[#1e2130] hover:border-[#3d4460]'
              }`}
            >
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[#e2e8f0] truncate">
                    {flow.name || 'Untitled'}
                  </span>
                  {flow.id === currentFlowId && (
                    <span className="text-[0.65rem] font-bold uppercase tracking-wider text-[#3b82f6] bg-[#3b82f6]/10 px-1.5 py-0.5 rounded">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#4a5568] truncate mt-0.5">
                  {flow.did || 'No DID'}
                  {' · '}
                  {flow.node_count} node{flow.node_count !== 1 ? 's' : ''}
                  {' · '}
                  {formatDate(flow.updated_at)}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  disabled={loadingId === flow.id}
                  onClick={() => void handleLoad(flow.id)}
                  className="text-xs px-3 py-1.5 rounded-md bg-[#3b82f6] text-white font-semibold hover:bg-[#2563eb] disabled:opacity-50 transition-colors"
                >
                  {loadingId === flow.id ? '...' : 'Load'}
                </button>
                <button
                  type="button"
                  disabled={deletingId === flow.id}
                  onClick={() => void handleDelete(flow.id)}
                  className="text-xs px-2.5 py-1.5 rounded-md border border-[#2a2f45] text-[#718096] hover:text-[#fca5a5] hover:border-red-500/30 disabled:opacity-50 transition-colors"
                >
                  {deletingId === flow.id ? '...' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
