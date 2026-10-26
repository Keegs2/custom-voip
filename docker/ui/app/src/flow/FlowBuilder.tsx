/**
 * FlowBuilder — the Visual IVR builder (plan §6.2).
 *
 *   ┌ top bar ── ← IVR · flow name · save state ─ undo redo tidy │ Flow assistant · Test call · History · Publish ┐
 *   ├ Blocks / Outline ┬──────────────── canvas ────────────────┬── block settings / checklist ──┤
 *   │ palette (drag or │ React Flow, light/dark, minimap        │ or a sheet: Flow assistant,   │
 *   │ click/Enter)     │ read-only when viewing a version or a  │ Publish, Test call, Version   │
 *   │                  │ Flow assistant proposal                │ history                       │
 *   └──────────────────┴────────────────────────────────────────┴───────────────────────────────┘
 *
 * Below 768px it is a read-only diagram + outline with "edit on a larger
 * screen" (the Flow assistant still works there, as a full-screen sheet).
 * The store is created HERE, once per mount: the route keys this component
 * by flow id and the page keys it by customer, so a switch of either starts
 * a fresh store, history and assistant conversation — nothing carries across.
 *
 * React #310: hooks first; the phone/desktop split is a child switch.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ChevronLeft,
  CircleAlert,
  Eye,
  FlaskConical,
  History,
  Loader2,
  MonitorSmartphone,
  Redo2,
  RotateCcw,
  Rocket,
  Sparkles,
  Undo2,
  Wand2,
} from 'lucide-react';
import type { Flow, Issue } from '../types/ivr';
import { useIvrWorkspace } from '../pages/ivr/IvrContext';
import { useDestinations, usePrompts } from '../pages/ivr/ivrData';
import { formatWhen } from '../pages/ivr/format';
import { createFlowStore, FlowStoreContext, slotKey, useFlow, useFlowStoreApi } from './store/flowStore';
import { FlowAnalysisContext, useFlowAnalysis, type FlowAnalysis, type ShownIssue } from './useFlowAnalysis';
import { BuilderDataContext, type BuilderData } from './BuilderData';
import { CanvasViewContext, type CanvasView } from './canvas/CanvasView';
import { FlowCanvas, type CanvasOverride } from './canvas/FlowCanvas';
import { useAutosave, type Autosave, type SaveStatus } from './useAutosave';
import { useIsNarrow } from './useIsNarrow';
import { Palette } from './panels/Palette';
import { Outline } from './panels/Outline';
import { Inspector } from './panels/Inspector';
import { PublishPanel } from './panels/PublishPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { SimulatorPanel, type SimulatorTarget } from './panels/SimulatorPanel';
import { ConflictDialog } from './panels/ConflictDialog';
import { AddBlockMenu, type AddRequest } from './panels/AddBlockMenu';
import { blockTitle } from './model/summary';
import { AssistProvider, useAssist, useFlowAssistant, type FlowAssistant } from './assist/useFlowAssistant';
import { AssistAnnouncer, AssistPanel } from './assist/AssistPanel';
import { ProposalBanner } from './assist/ProposalBanner';
import { proposalChanges, proposalPromptName, type ProposalChanges } from './assist/model';

export interface FlowBuilderProps {
  flow: Flow;
  maxBlocks?: number;
  /** `summary.assist.available` — the Flow assistant is on for this account. */
  assistAvailable?: boolean;
}

export function FlowBuilder({ flow, maxBlocks, assistAvailable = false }: FlowBuilderProps) {
  // One store per mounted builder (see the header).
  const [store] = useState(() => createFlowStore(flow));
  return (
    <FlowStoreContext.Provider value={store}>
      <ReactFlowProvider>
        <BuilderShell maxBlocks={maxBlocks} assistAvailable={assistAvailable} />
      </ReactFlowProvider>
    </FlowStoreContext.Provider>
  );
}

/** `assist-sim` = Test call on the Flow assistant's proposal (closing it returns to the assistant). */
type Sheet = 'publish' | 'history' | 'sim' | 'assist' | 'assist-sim' | null;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** The server's findings on a proposal, pinned to its blocks like the draft's. */
function pinIssues(byId: ReadonlyMap<string, unknown>, errors: readonly Issue[], warnings: readonly Issue[]) {
  const out = new Map<string, ShownIssue[]>();
  const pin = (list: readonly Issue[], severity: 'error' | 'warning') => {
    for (const i of list) {
      if (!i.node_id || !byId.has(i.node_id)) continue;
      const shown: ShownIssue = {
        severity,
        code: i.code,
        message: i.message,
        nodeId: i.node_id,
        ...(i.handle ? { handle: i.handle } : {}),
        source: 'server',
      };
      out.set(i.node_id, [...(out.get(i.node_id) ?? []), shown]);
    }
  };
  pin(errors, 'error');
  pin(warnings, 'warning');
  return out;
}

function BuilderShell({ maxBlocks, assistAvailable }: { maxBlocks?: number; assistAvailable: boolean }) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const store = useFlowStoreApi();
  const narrow = useIsNarrow();
  const meta = useFlow((s) => s.meta);
  const preview = useFlow((s) => s.preview);
  const proposal = useFlow((s) => s.proposal);
  const draftGraph = useFlow((s) => s.contentGraph());
  const prompts = usePrompts(ws.scope);
  const destinations = useDestinations(ws.scope);
  const readOnly = !ws.canEdit;
  const autosave = useAutosave(store, ws.scope, readOnly);
  const [sheetState, setSheet] = useState<Sheet>(null);
  const [addRequest, setAddRequest] = useState<AddRequest | null>(null);
  const narrowRef = useRef(narrow);
  useEffect(() => {
    narrowRef.current = narrow;
  });
  // On a phone the assistant covers the screen: it steps aside when a proposal lands, so it can be seen.
  const onProposal = useCallback(() => {
    if (narrowRef.current) setSheet((s) => (s === 'assist' ? null : s));
  }, []);
  const assist = useFlowAssistant({
    store,
    flowId: meta.id,
    scope: ws.scope,
    enabled: assistAvailable,
    canEdit: ws.canEdit,
    onProposal,
  });
  const shown = assist.state.proposal;
  const changes = useMemo<ProposalChanges | null>(
    () => (shown ? proposalChanges(draftGraph, shown.result.draft_graph) : null),
    [shown, draftGraph],
  );
  const newPrompts = shown?.result.new_prompts;

  const analysis = useFlowAnalysis({
    flowId: meta.id,
    scope: ws.scope,
    ownDids: meta.numbers,
    prompts: prompts.data,
    destinations: destinations.data,
    maxBlocks,
    serverCheck: !readOnly,
  });

  const data = useMemo<BuilderData>(
    () => ({
      prompts: prompts.data,
      destinations: destinations.data,
      destinationsLoading: destinations.isLoading,
      destinationsFailed: destinations.isError,
      ownDids: meta.numbers,
      readOnly: readOnly || preview !== null || proposal !== null,
    }),
    [prompts.data, destinations.data, destinations.isLoading, destinations.isError, meta.numbers, readOnly, preview, proposal],
  );

  // The proposal on the canvas: every block laid out (so the first framing
  // fits the whole flow), the ones not revealed yet invisible.
  const proposalOverride = useMemo<CanvasOverride | null>(() => {
    if (!proposal) return null;
    const on = new Set(proposal.order.slice(0, proposal.revealed));
    return {
      nodes: proposal.nodes.map((n) => ({ ...n, className: on.has(n.id) ? 'ivr-rf-in' : 'ivr-rf-pending' })),
      edges: proposal.edges
        .filter((e) => on.has(e.source) && on.has(e.target))
        .map((e) => ({ ...e, className: 'ivr-rf-edge-in' })),
      pending: new Set(proposal.order.slice(proposal.revealed)),
    };
  }, [proposal]);
  const overlay: CanvasOverride | null = preview ?? proposalOverride;

  const view = useMemo<CanvasView>(() => {
    if (preview) {
      const targets = new Map(preview.edges.map((e) => [`${e.source}\u0000${e.sourceHandle ?? 'next'}`, e.target]));
      const byId = new Map(preview.nodes.map((n) => [n.id, n]));
      return {
        targets,
        titleOf: (id) => {
          const n = byId.get(id);
          return n ? blockTitle(n) : 'a deleted block';
        },
        issuesByNode: new Map(),
        reachable: null,
        summary: {
          ...analysis.summary,
          titleOf: (id) => {
            const n = byId.get(id);
            return n ? blockTitle(n) : null;
          },
        },
        readOnly: true,
        onAddAfter: null,
      };
    }
    if (proposal) {
      const byId = new Map(proposal.nodes.map((n) => [n.id, n]));
      const titleOf = (id: string) => {
        const n = byId.get(id);
        return n ? blockTitle(n) : 'a deleted block';
      };
      return {
        targets: new Map(proposal.edges.map((e) => [slotKey(e.source, e.sourceHandle), e.target])),
        titleOf,
        issuesByNode: pinIssues(byId, shown?.result.issues ?? [], shown?.result.warnings ?? []),
        reachable: null,
        summary: {
          ...analysis.summary,
          // New messages are named on the blocks before they exist (negative placeholder ids).
          promptName: proposalPromptName(newPrompts ?? [], analysis.summary.promptName),
          titleOf: (id) => (byId.has(id) ? titleOf(id) : null),
        },
        readOnly: true,
        onAddAfter: null,
        marks: changes?.marks,
      };
    }
    return {
      targets: analysis.targets,
      titleOf: analysis.titleOf,
      issuesByNode: analysis.issuesByNode,
      reachable: analysis.compiled.reachable,
      summary: analysis.summary,
      readOnly,
      onAddAfter: readOnly ? null : (source, handle) => setAddRequest({ source, handle }),
    };
  }, [preview, proposal, shown, newPrompts, changes, analysis, readOnly]);

  const simTarget = useMemo<SimulatorTarget | null>(
    () => (proposal ? { assistJobId: proposal.jobId, nodes: proposal.nodes, titleOf: view.titleOf } : null),
    [proposal, view.titleOf],
  );

  // The sheet that can really show: the assistant's sheets need the assistant,
  // and its test call needs a proposal (without one it falls back to the panel).
  const sheet: Sheet =
    !assist.available && (sheetState === 'assist' || sheetState === 'assist-sim')
      ? null
      : sheetState === 'assist-sim' && !simTarget
        ? 'assist'
        : sheetState;

  const { refine } = assist;
  const onRefine = useCallback(() => {
    refine();
    setSheet('assist');
  }, [refine]);

  // Keyboard: undo / redo, Esc to deselect — never while typing in a field.
  useEffect(() => {
    if (readOnly || narrow) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.vm-dialog-root')) return;
      const mod = e.metaKey || e.ctrlKey;
      // A version or a proposal is on screen: undo would change the draft out of sight.
      const st = store.getState();
      if (mod && (st.preview !== null || st.proposal !== null) && ['z', 'y'].includes(e.key.toLowerCase())) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.getState().redo();
        else store.getState().undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.getState().redo();
      } else if (e.key === 'Escape' && !sheet && store.getState().selectedId) {
        store.getState().select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, readOnly, narrow, sheet]);

  return (
    <BuilderDataContext.Provider value={data}>
      <FlowAnalysisContext.Provider value={analysis}>
        <CanvasViewContext.Provider value={view}>
          <AssistProvider value={assist}>
            {narrow ? (
              <PhoneView
                autosave={autosave}
                overlay={proposalOverride}
                changes={changes}
                sheet={sheet}
                setSheet={setSheet}
                simTarget={simTarget}
                onRefine={onRefine}
              />
            ) : (
              <div className="ivr-builder">
                <TopBar autosave={autosave} analysis={analysis} assist={assist} sheet={sheet} setSheet={setSheet} />
                <div className={`ivr-work${sheet ? ' ivr-work--sheet' : ''}`}>
                  <LeftColumn
                    readOnly={readOnly}
                    overlay={overlay}
                    previewKind={preview ? 'version' : 'proposal'}
                  />
                  {/* A proposal's banner is docked above the canvas (the canvas
                      shrinks and frames the flow below it); a version's floats. */}
                  <div className={`ivr-canvas-wrap${!preview && proposal && shown ? ' ivr-canvas-wrap--docked' : ''}`}>
                    {preview && <PreviewBanner onRestore={() => setSheet('history')} />}
                    {!preview && proposal && shown && (
                      <ProposalBanner
                        key={shown.jobId}
                        variant="docked"
                        changes={changes}
                        onRefine={onRefine}
                        onTestCall={() => setSheet('assist-sim')}
                      />
                    )}
                    <div className="ivr-canvas-stage">
                      <FlowCanvas mode={overlay ? 'preview' : readOnly ? 'readonly' : 'edit'} override={overlay} />
                    </div>
                  </div>
                  <aside className="ivr-right" aria-label="Settings">
                    {sheet === 'publish' ? (
                      <PublishPanel
                        flush={autosave.flush}
                        onClose={() => setSheet(null)}
                        onConflict={() => setSheet(null)}
                      />
                    ) : sheet === 'history' ? (
                      <HistoryPanel flush={autosave.flush} onClose={() => setSheet(null)} onConflict={() => setSheet(null)} />
                    ) : sheet === 'sim' ? (
                      <SimulatorPanel onClose={() => setSheet(null)} />
                    ) : sheet === 'assist' ? (
                      <AssistPanel onClose={() => setSheet(null)} />
                    ) : sheet === 'assist-sim' && simTarget ? (
                      <SimulatorPanel key={simTarget.assistJobId} target={simTarget} onClose={() => setSheet('assist')} />
                    ) : (
                      <Inspector />
                    )}
                  </aside>
                </div>
              </div>
            )}
            {assist.available && <AssistAnnouncer />}
            {autosave.status.kind === 'conflict' && (
              <ConflictDialog onLoadLatest={autosave.loadLatest} onKeepMine={autosave.keepMine} />
            )}
            {addRequest && <AddBlockMenu request={addRequest} onClose={() => setAddRequest(null)} />}
          </AssistProvider>
        </CanvasViewContext.Provider>
      </FlowAnalysisContext.Provider>
    </BuilderDataContext.Provider>
  );
}

/* ─── Top bar ─────────────────────────────────────────────── */

function SaveState({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  switch (status.kind) {
    case 'readonly':
      return (
        <span className="ivr-save ivr-save-ro">
          <Eye size={13} aria-hidden="true" /> View only
        </span>
      );
    case 'saving':
      return (
        <span className="ivr-save">
          <Loader2 size={13} className="ivr-spin-ic" aria-hidden="true" /> Saving…
        </span>
      );
    case 'pending':
      return <span className="ivr-save ivr-save-pending">Unsaved changes</span>;
    case 'error':
      return (
        <span className="ivr-save ivr-save-err">
          <CircleAlert size={13} aria-hidden="true" /> Not saved — retrying
          <button type="button" className="vm-linkbtn ivr-linkbtn" onClick={onRetry}>
            Save now
          </button>
        </span>
      );
    case 'conflict':
      return (
        <span className="ivr-save ivr-save-err">
          <CircleAlert size={13} aria-hidden="true" /> Not saved — changed elsewhere
        </span>
      );
    case 'saved':
      return <span className="ivr-save ivr-save-ok">{status.at ? 'All changes saved' : 'Saved'}</span>;
  }
}

function TopBar({
  autosave,
  analysis,
  assist,
  sheet,
  setSheet,
}: {
  autosave: Autosave;
  analysis: FlowAnalysis;
  assist: FlowAssistant;
  sheet: Sheet;
  setSheet: (s: Sheet) => void;
}) {
  const ws = useIvrWorkspace();
  const store = useFlowStoreApi();
  const navigate = useNavigate();
  const name = useFlow((s) => s.name);
  const meta = useFlow((s) => s.meta);
  const canUndo = useFlow((s) => s.history.past.length > 0);
  const canRedo = useFlow((s) => s.history.future.length > 0);
  const preview = useFlow((s) => s.preview !== null);
  const proposalOn = useFlow((s) => s.proposal !== null);
  const readOnly = !ws.canEdit;
  const overlaid = preview || proposalOn;
  const assistOpen = sheet === 'assist' || sheet === 'assist-sim';
  const assistWorking = assist.state.running !== null || assist.state.sending;
  const testOn = sheet === 'sim' || sheet === 'assist-sim';
  const waitTitle = 'Accept or discard the proposal first';
  const toggle = (s: Exclude<Sheet, null>) => {
    if (s !== 'history' && preview) store.getState().exitPreview();
    setSheet(sheet === s ? null : s);
  };

  return (
    <header className="ivr-topbar">
      <Link
        to={ws.href('/ivr')}
        className="ivr-back"
        onClick={(e) => {
          e.preventDefault();
          void autosave.flush().finally(() => navigate(ws.href('/ivr')));
        }}
      >
        <ChevronLeft size={16} aria-hidden="true" /> IVR
      </Link>
      <div className="ivr-topbar-id">
        <label className="ivr-sr" htmlFor="ivr-flow-name">
          Flow name
        </label>
        <input
          id="ivr-flow-name"
          className="ivr-name-input"
          value={name}
          maxLength={100}
          disabled={readOnly}
          onChange={(e) => store.getState().setName(e.target.value)}
          onBlur={(e) => {
            if (!e.target.value.trim()) store.getState().setName('Untitled flow');
          }}
        />
        <div className="ivr-topbar-meta">
          <span className={`ivr-live${meta.publishedVersion ? ' ivr-live-on' : ''}`}>
            {meta.publishedVersion ? `Live · version ${meta.publishedVersion}` : 'Not published'}
          </span>
          {meta.publishedAt && <span className="ivr-topbar-when">published {formatWhen(meta.publishedAt)}</span>}
          <SaveState status={autosave.status} onRetry={() => void autosave.flush()} />
        </div>
      </div>
      <div className="ivr-topbar-tools">
        {!readOnly && (
          <div className="ivr-toolgroup" role="group" aria-label="Edit">
            <button
              type="button"
              className="ivr-tool"
              onClick={() => store.getState().undo()}
              disabled={!canUndo || overlaid}
              aria-label="Undo"
              title="Undo (⌘Z / Ctrl+Z)"
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ivr-tool"
              onClick={() => store.getState().redo()}
              disabled={!canRedo || overlaid}
              aria-label="Redo"
              title="Redo (⇧⌘Z / Ctrl+Y)"
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ivr-tool"
              onClick={() => store.getState().tidy()}
              disabled={overlaid}
              aria-label="Tidy up the layout"
              title="Tidy up the layout"
            >
              <Wand2 size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        {assist.available && (
          <button
            type="button"
            className={`dl-btn dl-btn-ghost ivr-top-btn ivr-top-assist${assistOpen ? ' ivr-top-on' : ''}`}
            onClick={() => toggle('assist')}
            aria-pressed={assistOpen}
            aria-label={assistWorking ? 'Flow assistant (working)' : 'Flow assistant'}
            title="Flow assistant"
          >
            <Sparkles size={15} aria-hidden="true" /> <span className="ivr-top-label">Flow assistant</span>
            {assistWorking && <span className="ivr-top-dot" aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          className={`dl-btn dl-btn-ghost ivr-top-btn${testOn ? ' ivr-top-on' : ''}`}
          onClick={() => toggle(proposalOn ? 'assist-sim' : 'sim')}
          aria-pressed={testOn}
          aria-label={proposalOn ? 'Test call on the proposal' : 'Test call'}
          title={proposalOn ? 'Test call on the proposal' : 'Test call'}
        >
          <FlaskConical size={15} aria-hidden="true" /> <span className="ivr-top-label">Test call</span>
        </button>
        <button
          type="button"
          className={`dl-btn dl-btn-ghost ivr-top-btn${sheet === 'history' ? ' ivr-top-on' : ''}`}
          onClick={() => toggle('history')}
          aria-pressed={sheet === 'history'}
          disabled={proposalOn}
          aria-label="History"
          title={proposalOn ? waitTitle : 'History'}
        >
          <History size={15} aria-hidden="true" /> <span className="ivr-top-label">History</span>
        </button>
        {!readOnly && (
          <button
            type="button"
            className="dl-btn dl-btn-primary ivr-top-publish"
            onClick={() => toggle('publish')}
            aria-pressed={sheet === 'publish'}
            disabled={proposalOn}
            title={proposalOn ? waitTitle : undefined}
          >
            <Rocket size={15} aria-hidden="true" /> Publish
            {analysis.errorCount > 0 && (
              <span className="ivr-top-count" aria-label={`${analysis.errorCount} to fix`}>
                {analysis.errorCount}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}

/* ─── Left column ─────────────────────────────────────────── */

function LeftColumn({
  readOnly,
  overlay,
  previewKind,
}: {
  readOnly: boolean;
  /** A read-only version or proposal on the canvas instead of the draft. */
  overlay: CanvasOverride | null;
  previewKind: 'version' | 'proposal';
}) {
  const previewing = overlay !== null;
  const [tab, setTab] = useState<'blocks' | 'outline'>(readOnly ? 'outline' : 'blocks');
  return (
    <aside className="ivr-left" aria-label="Blocks and outline">
      <div className="ivr-left-tabs" role="tablist" aria-label="Left panel">
        <button type="button" role="tab" aria-selected={tab === 'blocks'} className={`ivr-left-tab${tab === 'blocks' ? ' ivr-left-tab-on' : ''}`} onClick={() => setTab('blocks')}>
          Blocks
        </button>
        <button type="button" role="tab" aria-selected={tab === 'outline'} className={`ivr-left-tab${tab === 'outline' ? ' ivr-left-tab-on' : ''}`} onClick={() => setTab('outline')}>
          Outline
        </button>
      </div>
      <div className="ivr-left-body" role="tabpanel">
        {tab === 'blocks' ? (
          <Palette disabled={readOnly || previewing} previewing={previewing} previewKind={previewKind} />
        ) : (
          <Outline nodes={overlay?.nodes} />
        )}
      </div>
    </aside>
  );
}

/* ─── Viewing a published version ─────────────────────────── */

function PreviewBanner({ onRestore }: { onRestore: () => void }) {
  const store = useFlowStoreApi();
  const preview = useFlow((s) => s.preview);
  const ws = useIvrWorkspace();
  if (!preview) return null;
  return (
    <div className="ivr-preview-banner" role="status">
      <Eye size={15} aria-hidden="true" />
      <span>
        <strong>Viewing version {preview.version}</strong>, published {formatWhen(preview.publishedAt)}. Read-only — your
        draft is unchanged.
      </span>
      <span className="ivr-preview-actions">
        {ws.canEdit && (
          <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={onRestore}>
            <RotateCcw size={13} aria-hidden="true" /> Restore…
          </button>
        )}
        <button type="button" className="dl-btn dl-btn-primary ivr-btn-sm" onClick={() => store.getState().exitPreview()}>
          Back to your draft
        </button>
      </span>
    </div>
  );
}

/* ─── Phone width ─────────────────────────────────────────── */

function PhoneView({
  autosave,
  overlay,
  changes,
  sheet,
  setSheet,
  simTarget,
  onRefine,
}: {
  autosave: Autosave;
  /** A Flow assistant proposal shown instead of the draft. */
  overlay: CanvasOverride | null;
  changes: ProposalChanges | null;
  sheet: Sheet;
  setSheet: (s: Sheet) => void;
  simTarget: SimulatorTarget | null;
  onRefine: () => void;
}) {
  const ws = useIvrWorkspace();
  const assist = useAssist();
  const name = useFlow((s) => s.name);
  const meta = useFlow((s) => s.meta);
  const nodes = useFlow((s) => s.proposal?.nodes.length ?? s.nodes.length);
  const working = assist.state.running !== null || assist.state.sending;
  return (
    <div className="ivr-phone">
      <div className="ivr-phone-head">
        <Link to={ws.href('/ivr')} className="ivr-back">
          <ChevronLeft size={16} aria-hidden="true" /> IVR
        </Link>
        <h1 className="ivr-phone-title">{name}</h1>
        <div className="ivr-topbar-meta">
          <span className={`ivr-live${meta.publishedVersion ? ' ivr-live-on' : ''}`}>
            {meta.publishedVersion ? `Live · version ${meta.publishedVersion}` : 'Not published'}
          </span>
          <SaveState status={autosave.status.kind === 'saved' ? { kind: 'readonly' } : autosave.status} onRetry={() => void autosave.flush()} />
        </div>
        {assist.available && (
          <button
            type="button"
            className="dl-btn dl-btn-ghost ivr-btn-sm ivr-phone-assist"
            onClick={() => setSheet('assist')}
            aria-label={working ? 'Flow assistant (working)' : 'Flow assistant'}
          >
            <Sparkles size={14} aria-hidden="true" /> Flow assistant
            {working && <span className="ivr-top-dot" aria-hidden="true" />}
          </button>
        )}
      </div>
      <div className="ivr-phone-note">
        <MonitorSmartphone size={18} aria-hidden="true" />
        <p>
          <strong>Edit on a larger screen.</strong>{' '}
          {assist.available
            ? 'On a phone you can read the flow and ask the Flow assistant for one; open it on a tablet or computer to change blocks yourself.'
            : 'On a phone you can read the flow; open it on a tablet or computer to change it.'}
        </p>
      </div>
      {overlay && assist.state.proposal && (
        <ProposalBanner key={assist.state.proposal.jobId} variant="inline" changes={changes} onRefine={onRefine} onTestCall={() => setSheet('assist-sim')} />
      )}
      <div className="ivr-phone-canvas" style={{ '--ivr-phone-h': nodes > 6 ? '52vh' : '42vh' } as CSSProperties}>
        <FlowCanvas mode={overlay ? 'preview' : 'readonly'} override={overlay} compact />
      </div>
      <section className="ivr-phone-outline" aria-label="Flow outline">
        <h2 className="ivr-insp-h">{overlay ? 'The proposed flow, step by step' : 'The flow, step by step'}</h2>
        <Outline nodes={overlay?.nodes} />
      </section>
      {sheet === 'assist' && <AssistPanel fullscreen onClose={() => setSheet(null)} />}
      {sheet === 'assist-sim' && simTarget && (
        <SimulatorPanel key={simTarget.assistJobId} fullscreen target={simTarget} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}
