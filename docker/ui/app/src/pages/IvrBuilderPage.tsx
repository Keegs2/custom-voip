/**
 * IVR Builder Page
 *
 * Full-screen 3-pane layout (outside AppLayout) with:
 * - Left:   Verb palette (draggable cards)
 * - Center: Flow canvas (drop zones + nodes)
 * - Right:  Config panel (when a node is selected)
 *
 * Drag-and-drop is powered by @dnd-kit/core.
 * State is managed by useIvrFlow (useReducer).
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { createIvrFlow, updateIvrFlow } from '../api/ivr';

import { useIvrFlow } from './ivr/useIvrFlow';
import type { IvrFlowState } from './ivr/useIvrFlow';
import { generateXml, verbColor, verbTextClass, verbIcon, type BuilderNode } from './ivr/ivrUtils';
import type { IvrVerbType } from '../types/ivr';

import { IvrTopbar } from './ivr/IvrTopbar';
import { IvrPalette } from './ivr/IvrPalette';
import { IvrCanvas } from './ivr/IvrCanvas';
import { IvrConfigPanel } from './ivr/IvrConfigPanel';
import { IvrXmlModal } from './ivr/IvrXmlModal';
import { IvrLoadModal } from './ivr/IvrLoadModal';

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
      style={{ width: '180px' }}
    >
      <div
        className="absolute left-0 inset-y-0 w-[3px] rounded-l-lg"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-sm font-bold ml-1 ${textClass}`}
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
      style={{ width: '300px' }}
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
// Main page
// ---------------------------------------------------------------------------

export function IvrBuilderPage() {
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();
  const { state, dispatch, selectedNode } = useIvrFlow();

  // UI state
  const [showXmlModal, setShowXmlModal] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

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
      // Dropped a palette verb onto a drop zone → add new node
      dispatch({
        type: 'ADD_NODE',
        verb: activeData.verb as IvrVerbType,
        path: dropData.path,
        position: dropData.position,
      });
    } else if (activeData.type === 'node') {
      // Reordering an existing node
      dispatch({
        type: 'MOVE_NODE',
        nodeId: activeData.nodeId as string,
        targetPath: dropData.path,
        targetPosition: dropData.position,
      });
    }
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
      // The API IvrNode type uses branches: Record<string, string> and prompt?: string,
      // which are type-level simplifications — at runtime the server accepts nested node arrays.
      // We cast through unknown to satisfy TypeScript while preserving the actual data shape.
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
        // Persist the new id into state so subsequent saves use PUT
        dispatch({ type: 'LOAD_FLOW', state: { ...state, id: result.id } });
        toastOk('Flow created.');
      }
    } catch (err) {
      toastErr(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed.');
    } finally {
      setIsSaving(false);
    }
  }, [state, dispatch, toastOk, toastErr]);

  // ---------------------------------------------------------------------------
  // Load flow (from modal callback)
  // ---------------------------------------------------------------------------

  const handleLoadFlow = useCallback((loadedState: IvrFlowState) => {
    dispatch({ type: 'LOAD_FLOW', state: loadedState });
    toastOk('Flow loaded.');
  }, [dispatch, toastOk]);

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
      {/* Layout with sidebar */}
      <Sidebar />
      <div
        className="flex flex-col bg-[#0f1117]"
        style={{ marginLeft: 240, height: '100vh' }}
        onClick={() => {
          // Clicking the blank canvas deselects any selected node
          if (selectedNode) {
            dispatch({ type: 'SELECT_NODE', nodeId: null });
          }
        }}
      >
        {/* Top bar */}
        <IvrTopbar
          state={state}
          dispatch={dispatch}
          onSave={() => void handleSave()}
          onLoad={() => setShowLoadModal(true)}
          onPreviewXml={() => setShowXmlModal(true)}
          onNew={() => dispatch({ type: 'RESET' })}
          isSaving={isSaving}
          onBack={() => navigate(-1)}
        />

        {/* Main 3-pane area */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: Verb palette */}
          <IvrPalette />

          {/* Center: Flow canvas */}
          <main
            className="flex-1 overflow-y-auto p-6 flex flex-col items-center"
            role="main"
            aria-label="IVR flow canvas"
          >
            {/* START sentinel */}
            <div
              className="flex items-center justify-center w-20 h-8 rounded-full bg-[#1e2130] border border-[#2a2f45] mb-0"
              aria-label="Flow start"
            >
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-[#4a5568]">
                START
              </span>
            </div>

            {/* Connector from START to first node */}
            <div className="w-[2px] min-h-[12px] bg-[#2a2f45]" aria-hidden="true" />

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

          {/* Right: Config panel */}
          <IvrConfigPanel
            node={selectedNode}
            dispatch={dispatch}
          />
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

      {/* Load Flow Modal */}
      <IvrLoadModal
        open={showLoadModal}
        onClose={() => setShowLoadModal(false)}
        onLoad={handleLoadFlow}
        currentFlowId={state.id}
      />
    </DndContext>
  );
}
