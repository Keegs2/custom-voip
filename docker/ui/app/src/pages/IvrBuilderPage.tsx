/**
 * IVR Builder Page
 *
 * Layout (matches UCaaS Communications suite style):
 *   Sidebar (240px) | Flow list panel (280px) | Canvas + toolbar + config (flex-1)
 *
 * Left panel: persistent list of all IVR flows — matches Documents / Chat / Conferences
 * Right area: canvas toolbar (with verb palette) + DnD canvas + config panel
 *
 * Drag-and-drop is powered by @dnd-kit/core.
 * State is managed by useIvrFlow (useReducer).
 */

import { useState, useCallback, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';

import { useToast } from '../components/ui/ToastContext';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import { Spinner } from '../components/ui/Spinner';
import {
  listIvrFlows,
  getIvrFlow,
  createIvrFlow,
  updateIvrFlow,
  deleteIvrFlow,
} from '../api/ivr';

import { useIvrFlow } from './ivr/useIvrFlow';
import type { IvrFlowState } from './ivr/useIvrFlow';
import { generateXml, verbColor, verbTextClass, verbIcon, type BuilderNode } from './ivr/ivrUtils';
import type { IvrVerbType, IvrFlowListItem } from '../types/ivr';

import { IvrTopbar } from './ivr/IvrTopbar';
import { IvrCanvas } from './ivr/IvrCanvas';
import { IvrConfigPanel } from './ivr/IvrConfigPanel';
import { IvrXmlModal } from './ivr/IvrXmlModal';

// ---------------------------------------------------------------------------
// Drag overlay ghost components
// ---------------------------------------------------------------------------

interface PaletteGhostProps {
  verb: IvrVerbType;
}

function PaletteGhost({ verb }: PaletteGhostProps) {
  const accentColor = verbColor(verb);
  const textClass = verbTextClass(verb);
  const icon = verbIcon(verb);

  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-[#3d4460] bg-[#1e2130] shadow-[0_8px_24px_rgba(0,0,0,0.5)] opacity-95 pointer-events-none"
      style={{ width: '160px' }}
    >
      <div
        className="absolute left-0 inset-y-0 w-[3px] rounded-l-lg"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />
      <div
        className={`flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold ml-1 ${textClass}`}
        style={{ backgroundColor: `${accentColor}22` }}
      >
        {icon}
      </div>
      <span className={`text-xs font-bold ${textClass}`}>{verb.toUpperCase()}</span>
    </div>
  );
}

interface NodeGhostProps {
  node: BuilderNode;
}

function NodeGhost({ node }: NodeGhostProps) {
  const accentColor = verbColor(node.type);

  return (
    <div
      className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[#3d4460] bg-[#1a1d27] shadow-[0_8px_24px_rgba(0,0,0,0.5)] opacity-90 pointer-events-none"
      style={{ width: '280px' }}
    >
      <div
        className="w-[3px] h-full min-h-[28px] rounded-full flex-shrink-0"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />
      <span className="text-xs font-semibold text-[#718096] uppercase tracking-wide">{node.type}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left panel — Flow list item
// ---------------------------------------------------------------------------

interface FlowListItemProps {
  flow: IvrFlowListItem;
  isSelected: boolean;
  onClick: () => void;
}

function FlowListItem({ flow, isSelected, onClick }: FlowListItemProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      aria-pressed={isSelected}
      aria-label={`Load flow: ${flow.name || 'Untitled'}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '8px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background 0.12s, color 0.12s',
        background: isSelected
          ? 'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(59,130,246,0.08) 100%)'
          : 'transparent',
        marginBottom: 1,
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLDivElement).style.background = 'transparent';
        }
      }}
    >
      {/* Flow name */}
      <div
        style={{
          fontSize: '0.825rem',
          fontWeight: isSelected ? 700 : 500,
          color: isSelected ? '#e2e8f0' : '#94a3b8',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {flow.name || 'Untitled'}
      </div>

      {/* Meta: DID + node count */}
      <div
        style={{
          fontSize: '0.7rem',
          color: isSelected ? '#64748b' : '#475569',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {flow.did ? (
          <span
            style={{
              background: 'rgba(6,182,212,0.1)',
              border: '1px solid rgba(6,182,212,0.2)',
              borderRadius: 4,
              padding: '0 5px',
              fontSize: '0.65rem',
              color: '#22d3ee',
              fontFamily: 'monospace',
            }}
          >
            {flow.did}
          </span>
        ) : (
          <span style={{ color: '#334155' }}>No DID</span>
        )}
        <span style={{ color: '#334155' }}>·</span>
        <span>{flow.node_count} node{flow.node_count !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty canvas placeholder text
// ---------------------------------------------------------------------------

function NoFlowSelected() {
  return (
    <div
      className="flex flex-col items-center justify-center h-full text-center"
      style={{ padding: '40px 32px' }}
    >
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5"
        style={{
          background: 'rgba(6,182,212,0.07)',
          border: '1px solid rgba(6,182,212,0.18)',
        }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="#06b6d4" strokeWidth={1.4} style={{ width: 28, height: 28 }}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <path d="M17.5 17.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0" />
          <path d="M14 10.5h3a1 1 0 0 1 1 1V15" strokeLinecap="round" />
          <path d="M6.5 10v4" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm font-semibold" style={{ color: '#475569', marginBottom: 6 }}>
        No flow selected
      </p>
      <p className="text-xs leading-relaxed" style={{ color: '#334155', maxWidth: 240 }}>
        Choose a flow from the left panel, or click "New" to create one.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function IvrBuilderPage() {
  const { toastOk, toastErr } = useToast();
  const { state, dispatch, selectedNode } = useIvrFlow();

  // UI state
  const [showXmlModal, setShowXmlModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Left panel — flow list
  const [flows, setFlows] = useState<IvrFlowListItem[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(true);
  const [flowsError, setFlowsError] = useState<string | null>(null);

  // Whether a flow is loaded into the builder (id != null OR user just hit "New")
  const [hasActiveFlow, setHasActiveFlow] = useState(false);

  // Drag state — track what is being dragged (palette verb or canvas node id)
  const [activeDragVerb, setActiveDragVerb] = useState<IvrVerbType | null>(null);
  const [activeDragNodeId, setActiveDragNodeId] = useState<string | null>(null);

  // @dnd-kit sensors — require 8px of movement before drag starts (prevents accidental drags)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  // ---------------------------------------------------------------------------
  // Fetch flow list on mount
  // ---------------------------------------------------------------------------

  const fetchFlows = useCallback(async () => {
    setFlowsLoading(true);
    setFlowsError(null);
    try {
      const list = await listIvrFlows();
      setFlows(list);
    } catch (err) {
      setFlowsError(err instanceof Error ? err.message : 'Failed to load flows');
    } finally {
      setFlowsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFlows();
  }, [fetchFlows]);

  // ---------------------------------------------------------------------------
  // Load a flow from the list panel
  // ---------------------------------------------------------------------------

  const handleSelectFlow = useCallback(async (id: number) => {
    try {
      const flow = await getIvrFlow(id);

      // Map API node shape to BuilderNode (add prompt/branches arrays)
      const buildNodes = (rawNodes: typeof flow.nodes): BuilderNode[] =>
        rawNodes.map((n) => ({
          id: n.id,
          type: n.type,
          config: n.config as Record<string, string>,
          prompt: [],
          branches: {},
          _activeBranch: null,
        }));

      const loadedState: IvrFlowState = {
        id: flow.id,
        name: flow.name,
        customerId: null,
        did: flow.did ?? null,
        nodes: buildNodes(flow.nodes),
        selectedNodeId: null,
      };

      dispatch({ type: 'LOAD_FLOW', state: loadedState });
      setHasActiveFlow(true);
    } catch (err) {
      toastErr(err instanceof Error ? `Failed to load flow: ${err.message}` : 'Failed to load flow');
    }
  }, [dispatch, toastErr]);

  // ---------------------------------------------------------------------------
  // New flow
  // ---------------------------------------------------------------------------

  const handleNewFlow = useCallback(() => {
    dispatch({ type: 'RESET' });
    setHasActiveFlow(true);
  }, [dispatch]);

  // ---------------------------------------------------------------------------
  // Save flow
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!state.name.trim()) {
      toastErr('Please enter a flow name before saving.');
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: state.name,
        description: null,
        did: state.did,
        nodes: state.nodes.map((n) => ({
          id: n.id,
          type: n.type,
          config: n.config as Record<string, unknown>,
          prompt: n.prompt as unknown as string,
          branches: n.branches as unknown as Record<string, string>,
        })),
        entry_node_id: state.nodes.length > 0 ? state.nodes[0].id : null,
      } as Parameters<typeof createIvrFlow>[0];

      if (state.id) {
        await updateIvrFlow(state.id, payload);
        toastOk('Flow saved.');
      } else {
        const result = await createIvrFlow(payload);
        dispatch({ type: 'LOAD_FLOW', state: { ...state, id: result.id } });
        toastOk('Flow created.');
      }

      // Refresh the list so the new/updated flow appears with correct meta
      await fetchFlows();
    } catch (err) {
      toastErr(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed.');
    } finally {
      setIsSaving(false);
    }
  }, [state, dispatch, toastOk, toastErr, fetchFlows]);

  // ---------------------------------------------------------------------------
  // Delete flow
  // ---------------------------------------------------------------------------

  const handleDelete = useCallback(async () => {
    if (!state.id) return;
    if (!window.confirm('Delete this flow? This cannot be undone.')) return;

    setIsDeleting(true);
    try {
      await deleteIvrFlow(state.id);
      dispatch({ type: 'RESET' });
      setHasActiveFlow(false);
      await fetchFlows();
      toastOk('Flow deleted.');
    } catch (err) {
      toastErr(err instanceof Error ? `Delete failed: ${err.message}` : 'Delete failed.');
    } finally {
      setIsDeleting(false);
    }
  }, [state.id, dispatch, toastOk, toastErr, fetchFlows]);

  // ---------------------------------------------------------------------------
  // Drag handlers
  // ---------------------------------------------------------------------------

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (!data) return;

    if (data.type === 'palette') {
      setActiveDragVerb(data.verb as IvrVerbType);
      setActiveDragNodeId(null);
    } else if (data.type === 'node') {
      setActiveDragNodeId(data.nodeId as string);
      setActiveDragVerb(null);
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { over, active } = event;

    setActiveDragVerb(null);
    setActiveDragNodeId(null);

    if (!over) return;

    const dropData = over.data.current as { path: string; position: number } | undefined;
    if (!dropData) return;

    const activeData = active.data.current;
    if (!activeData) return;

    if (activeData.type === 'palette') {
      dispatch({
        type: 'ADD_NODE',
        verb: activeData.verb as IvrVerbType,
        path: dropData.path,
        position: dropData.position,
      });
    } else if (activeData.type === 'node') {
      dispatch({
        type: 'MOVE_NODE',
        nodeId: activeData.nodeId as string,
        targetPath: dropData.path,
        targetPosition: dropData.position,
      });
    }
  }, [dispatch]);

  // ---------------------------------------------------------------------------
  // Find the active dragging node (for DragOverlay)
  // ---------------------------------------------------------------------------

  const findDraggingNode = useCallback((): BuilderNode | null => {
    if (!activeDragNodeId) return null;
    function search(nodes: BuilderNode[]): BuilderNode | null {
      for (const n of nodes) {
        if (n.id === activeDragNodeId) return n;
        const inPrompt = search(n.prompt);
        if (inPrompt) return inPrompt;
        for (const branch of Object.values(n.branches)) {
          const inBranch = search(branch);
          if (inBranch) return inBranch;
        }
      }
      return null;
    }
    return search(state.nodes);
  }, [activeDragNodeId, state.nodes]);

  const draggingNode = findDraggingNode();

  // Pre-generate XML for the preview modal
  const previewXml = generateXml(state.nodes);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: '#0f1117' }}>
        {/* Nav sidebar (240px) */}
        <Sidebar />
        <SoftphoneWidget />

        {/* Content area — sits to the right of the 240px sidebar */}
        <div style={{ marginLeft: 240, flex: 1, display: 'flex', overflow: 'hidden', height: '100vh' }}>

          {/* ── Left panel: flow list (280px) ─────────────────── */}
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
            {/* Panel header */}
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
              <span
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  color: '#334155',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                }}
              >
                IVR Flows
              </span>

              {/* New flow button */}
              <button
                type="button"
                onClick={handleNewFlow}
                title="Create a new IVR flow"
                aria-label="New IVR flow"
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
                {/* Plus icon */}
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 12, height: 12 }} aria-hidden="true">
                  <path d="M8 3v10M3 8h10" strokeLinecap="round" />
                </svg>
                New
              </button>
            </div>

            {/* Flow list — scrollable */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
              {flowsLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 0', gap: 8 }}>
                  <Spinner size="sm" />
                  <span style={{ fontSize: '0.75rem', color: '#475569' }}>Loading...</span>
                </div>
              ) : flowsError ? (
                <div style={{ padding: '16px 8px', textAlign: 'center' }}>
                  <p style={{ fontSize: '0.75rem', color: '#f87171', marginBottom: 8 }}>{flowsError}</p>
                  <button
                    type="button"
                    onClick={() => void fetchFlows()}
                    style={{
                      fontSize: '0.72rem',
                      color: '#60a5fa',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : flows.length === 0 ? (
                <div style={{ padding: '24px 12px', textAlign: 'center' }}>
                  <p style={{ fontSize: '0.78rem', color: '#475569', fontWeight: 600, marginBottom: 4 }}>No flows yet</p>
                  <p style={{ fontSize: '0.7rem', color: '#334155', lineHeight: 1.5 }}>
                    Click "New" to create your first IVR flow.
                  </p>
                </div>
              ) : (
                flows.map((flow) => (
                  <FlowListItem
                    key={flow.id}
                    flow={flow}
                    isSelected={flow.id === state.id}
                    onClick={() => void handleSelectFlow(flow.id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* ── Right area: toolbar + canvas + config ─────────── */}
          <div
            style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}
            onClick={() => {
              // Clicking the blank canvas deselects any selected node
              if (selectedNode) {
                dispatch({ type: 'SELECT_NODE', nodeId: null });
              }
            }}
          >
            {hasActiveFlow ? (
              <>
                {/* Canvas toolbar (name + customer/DID + palette + actions) */}
                <IvrTopbar
                  state={state}
                  dispatch={dispatch}
                  onSave={() => void handleSave()}
                  onPreviewXml={() => setShowXmlModal(true)}
                  onDelete={() => void handleDelete()}
                  isSaving={isSaving}
                  isDeleting={isDeleting}
                />

                {/* Main canvas + config pane row */}
                <div className="flex flex-1 min-h-0 overflow-hidden">
                  {/* Center: flow canvas */}
                  <main
                    className="flex-1 overflow-y-auto p-6 flex flex-col items-center"
                    role="main"
                    aria-label="IVR flow canvas"
                    style={{ background: '#0f1117' }}
                  >
                    {/* START sentinel */}
                    <div
                      className="flex items-center justify-center gap-1.5 px-4 h-8 rounded-full mb-0"
                      style={{
                        background: 'rgba(6,182,212,0.08)',
                        border: '1px solid rgba(6,182,212,0.25)',
                        boxShadow: '0 0 10px rgba(6,182,212,0.08)',
                      }}
                      aria-label="Flow start"
                    >
                      <div
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: '#06b6d4', boxShadow: '0 0 4px rgba(6,182,212,0.6)' }}
                        aria-hidden="true"
                      />
                      <span
                        className="text-[0.6rem] font-bold uppercase tracking-[1.5px]"
                        style={{ color: '#06b6d4' }}
                      >
                        START
                      </span>
                    </div>

                    {/* Connector from START to first node */}
                    <div
                      className="w-[2px] min-h-[12px]"
                      style={{ background: 'linear-gradient(to bottom, rgba(6,182,212,0.3), rgba(42,47,69,0.6))' }}
                      aria-hidden="true"
                    />

                    {/* Node tree */}
                    <div className="w-full max-w-[600px]" onClick={(e) => e.stopPropagation()}>
                      <IvrCanvas
                        nodes={state.nodes}
                        path="nodes"
                        selectedNodeId={state.selectedNodeId}
                        dispatch={dispatch}
                      />
                    </div>

                    {/* Bottom padding so users can scroll past the last node */}
                    <div style={{ height: '80px' }} />
                  </main>

                  {/* Right: config panel */}
                  <IvrConfigPanel
                    node={selectedNode}
                    dispatch={dispatch}
                  />
                </div>
              </>
            ) : (
              <NoFlowSelected />
            )}
          </div>
        </div>
      </div>

      {/* Drag overlay — ghost shown while dragging */}
      <DragOverlay dropAnimation={null}>
        {activeDragVerb && <PaletteGhost verb={activeDragVerb} />}
        {activeDragNodeId && draggingNode && <NodeGhost node={draggingNode} />}
      </DragOverlay>

      {/* XML Preview Modal */}
      <IvrXmlModal
        open={showXmlModal}
        xml={previewXml}
        onClose={() => setShowXmlModal(false)}
      />
    </DndContext>
  );
}
