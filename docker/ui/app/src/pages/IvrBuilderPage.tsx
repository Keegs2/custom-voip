/**
 * IvrBuilderPage — the LIVE visual IVR flow builder.
 *
 * This is the shell that composes the (already-built) IVR builder pieces under
 * `src/pages/ivr/*` into a working editor and wires persistence through
 * `src/api/ivr.ts`:
 *
 *   useIvrFlow()  — reducer-backed node tree (source of truth)
 *   DndContext    — drag from IvrPalette / reorder IvrNode -> IvrDropZone
 *   IvrTopbar     — name, customer/DID, Preview XML, Delete, Save
 *   IvrCanvas     — recursive node render + drop targets
 *   IvrConfigPanel— selected-node editor
 *   IvrXmlModal   — TwiML preview
 *   IvrLoadModal  — load a saved flow
 *
 * Gated to account types that have IVR ({ api, hybrid, ucaas }); admins pass.
 * Any other account (or unauthenticated) gets a safe "not available" state.
 *
 * React #310: EVERY hook is declared unconditionally at the very top, before any
 * early return. This file previously shipped as a placeholder — do not reorder.
 */

import { useState, useCallback } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useMutation } from '@tanstack/react-query';
import { PortalHeader } from './RcfPage';
import { useAuth } from '../contexts/AuthContext';
import { IconIVR } from '../components/icons/ProductIcons';
import { useToast } from '../components/ui/Toast';
import { Button } from '../components/ui/Button';

import { useIvrFlow, type IvrFlowState } from './ivr/useIvrFlow';
import { IvrTopbar } from './ivr/IvrTopbar';
import { IvrCanvas } from './ivr/IvrCanvas';
import { IvrConfigPanel } from './ivr/IvrConfigPanel';
import { IvrXmlModal } from './ivr/IvrXmlModal';
import { IvrLoadModal } from './ivr/IvrLoadModal';
import {
  generateXml,
  findNode,
  verbColor,
  verbIcon,
  type BuilderNode,
} from './ivr/ivrUtils';
import type { IvrVerbType } from '../types/ivr';
import type { IvrFlowSave } from '../types/ivr';
import { createIvrFlow, updateIvrFlow, deleteIvrFlow } from '../api/ivr';

/** Account types that get the IVR builder. */
const ALLOWED_ACCOUNT_TYPES = new Set(['api', 'hybrid', 'ucaas']);

/**
 * Serialize the builder's in-memory tree to the API's flat IvrNode shape.
 *
 * The API's IvrNode has `branches: Record<string, string>` (id references) and
 * no nested prompt array; the builder keeps richer nested state in-session.
 * Persist the linear verb list + config for each node — this matches both the
 * IvrNode contract and IvrLoadModal's loader (which restores a flat list).
 */
function toApiNodes(nodes: BuilderNode[]): IvrFlowSave['nodes'] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    config: n.config as Record<string, unknown>,
    branches: {},
  }));
}

export function IvrBuilderPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { user, isAdmin } = useAuth();
  const { toastOk, toastErr } = useToast();
  const { state, dispatch, selectedNode } = useIvrFlow();

  const [activeDrag, setActiveDrag] = useState<
    | { kind: 'palette'; verb: IvrVerbType }
    | { kind: 'node'; verb: IvrVerbType }
    | null
  >(null);
  const [xmlOpen, setXmlOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);

  // Require a small movement before a drag starts so node clicks still select.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const saveMutation = useMutation({
    mutationFn: (payload: { id: number | null; body: IvrFlowSave }) =>
      payload.id !== null ? updateIvrFlow(payload.id, payload.body) : createIvrFlow(payload.body),
    onSuccess: (saved) => {
      // Record the (possibly new) persisted id without disturbing the tree.
      dispatch({ type: 'LOAD_FLOW', state: { ...state, id: saved.id } });
      toastOk('Flow saved');
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to save flow'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteIvrFlow(id),
    onSuccess: () => {
      dispatch({ type: 'RESET' });
      toastOk('Flow deleted');
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to delete flow'),
  });

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as
        | { verb?: IvrVerbType; type?: string; nodeId?: string }
        | undefined;
      if (data?.type === 'palette' && data.verb) {
        setActiveDrag({ kind: 'palette', verb: data.verb });
      } else if (data?.type === 'node' && data.nodeId) {
        // Resolve the dragged node's verb from the tree for the overlay label.
        const found = findNode(state.nodes, data.nodeId);
        setActiveDrag({ kind: 'node', verb: found?.node.type ?? 'say' });
      }
    },
    [state.nodes],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      const { active, over } = event;
      if (!over) return;

      const overData = over.data.current as { path?: string; position?: number } | undefined;
      if (!overData || overData.path === undefined || overData.position === undefined) return;

      const activeData = active.data.current as
        | { verb?: IvrVerbType; type?: string; nodeId?: string }
        | undefined;
      if (!activeData) return;

      if (activeData.type === 'palette' && activeData.verb) {
        dispatch({
          type: 'ADD_NODE',
          verb: activeData.verb,
          path: overData.path,
          position: overData.position,
        });
      } else if (activeData.type === 'node' && activeData.nodeId) {
        dispatch({
          type: 'MOVE_NODE',
          nodeId: activeData.nodeId,
          targetPath: overData.path,
          targetPosition: overData.position,
        });
      }
    },
    [dispatch],
  );

  const handleSave = useCallback(() => {
    const name = state.name.trim();
    if (!name) {
      toastErr('Give your flow a name before saving');
      return;
    }
    if (state.nodes.length === 0) {
      toastErr('Add at least one verb before saving');
      return;
    }
    const body: IvrFlowSave = {
      name,
      did: state.did,
      nodes: toApiNodes(state.nodes),
      entry_node_id: state.nodes[0]?.id ?? null,
    };
    saveMutation.mutate({ id: state.id, body });
  }, [state, saveMutation, toastErr]);

  const handleDelete = useCallback(() => {
    if (state.id === null) return;
    if (!confirm('Delete this flow? This cannot be undone.')) return;
    deleteMutation.mutate(state.id);
  }, [state.id, deleteMutation]);

  const handleLoad = useCallback(
    (loaded: IvrFlowState) => {
      dispatch({ type: 'LOAD_FLOW', state: loaded });
    },
    [dispatch],
  );

  const handleNew = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, [dispatch]);

  // ── Gate (early return AFTER all hooks) ───────────────────────────────────
  const accountType = user?.account_type ?? null;
  const hasAccess = isAdmin || (accountType !== null && ALLOWED_ACCOUNT_TYPES.has(accountType));

  if (!hasAccess) {
    return (
      <div>
        <PortalHeader
          icon={<IconIVR size={24} />}
          title="IVR Builder"
          subtitle="Visual drag-and-drop IVR flow designer."
          badgeVariant="rcf"
        />
        <NotAvailableState />
      </div>
    );
  }

  return (
    <div>
      <PortalHeader
        icon={<IconIVR size={24} />}
        title="IVR Builder"
        subtitle="Drag verbs onto the canvas to design your call flow, then save it to a number."
        badgeVariant="rcf"
      />

      {/* Load / New toolbar (above the builder frame) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" onClick={() => setLoadOpen(true)}>
          Load Flow
        </Button>
        <Button variant="ghost" size="sm" onClick={handleNew}>
          New Flow
        </Button>
        {state.id !== null && (
          <span
            style={{
              fontSize: '0.72rem',
              color: '#475569',
              fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
            }}
          >
            Editing flow #{state.id}
          </span>
        )}
      </div>

      {/* Builder frame */}
      <div
        className="glass-surface"
        style={{
          borderRadius: 16,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          height: 'min(72vh, 760px)',
          padding: 0,
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          {/* Topbar: name / customer / DID / preview / delete / save */}
          <IvrTopbar
            state={state}
            dispatch={dispatch}
            onSave={handleSave}
            onPreviewXml={() => setXmlOpen(true)}
            onDelete={handleDelete}
            isSaving={saveMutation.isPending}
            isDeleting={deleteMutation.isPending}
          />

          {/* Canvas + config panel */}
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                overflowY: 'auto',
                padding: '24px 20px',
                background: '#0b0d13',
              }}
            >
              <IvrCanvas
                nodes={state.nodes}
                path="nodes"
                selectedNodeId={state.selectedNodeId}
                dispatch={dispatch}
              />
            </div>

            <IvrConfigPanel node={selectedNode} dispatch={dispatch} />
          </div>

          {/* Drag preview */}
          <DragOverlay dropAnimation={null}>
            {activeDrag ? <DragChip verb={activeDrag.verb} /> : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Modals */}
      <IvrXmlModal open={xmlOpen} xml={generateXml(state.nodes)} onClose={() => setXmlOpen(false)} />
      <IvrLoadModal
        open={loadOpen}
        onClose={() => setLoadOpen(false)}
        onLoad={handleLoad}
        currentFlowId={state.id}
      />
    </div>
  );
}

/* ── Drag overlay chip ───────────────────────────────────────────────────── */

function DragChip({ verb }: { verb: IvrVerbType }) {
  const color = verbColor(verb);
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 8,
        border: `1px solid ${color}66`,
        background: `${color}1a`,
        boxShadow: `0 8px 24px ${color}40`,
        cursor: 'grabbing',
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.66rem',
          fontWeight: 700,
          background: `${color}26`,
          color,
        }}
        aria-hidden="true"
      >
        {verbIcon(verb)}
      </span>
      <span style={{ fontSize: '0.78rem', fontWeight: 700, color, textTransform: 'capitalize' }}>
        {verb}
      </span>
    </div>
  );
}

/* ── Not-available gate ──────────────────────────────────────────────────── */

function NotAvailableState() {
  const ACCENT = '#3b82f6';
  return (
    <div
      className="glass-surface"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        textAlign: 'center',
        borderRadius: 20,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 24,
          background: `linear-gradient(135deg, ${ACCENT}26 0%, ${ACCENT}0d 100%)`,
          border: `1px solid ${ACCENT}40`,
          color: '#60a5fa',
          boxShadow: `0 0 24px ${ACCENT}2e`,
        }}
        aria-hidden="true"
      >
        <IconIVR size={30} />
      </div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
        Not available for your account
      </h2>
      <p style={{ fontSize: '0.9rem', color: '#718096', maxWidth: 440, lineHeight: 1.6 }}>
        The IVR Builder is included with API, Hybrid, and UCaaS plans. To add visual call-flow
        design to your account, please contact support.
      </p>
    </div>
  );
}
