/**
 * FlowBuilder — the Visual IVR builder (plan §6.2).
 *
 *   ┌ top bar ── ← IVR · flow name · save state ─── undo redo tidy │ Test call · History · Publish ┐
 *   ├ Blocks / Outline ┬──────────────── canvas ────────────────┬── block settings / checklist ──┤
 *   │ palette (drag or │ React Flow, light/dark, minimap        │ or a sheet: Publish,          │
 *   │ click/Enter)     │ read-only when viewing a version       │ Test call, Version history    │
 *   └──────────────────┴────────────────────────────────────────┴───────────────────────────────┘
 *
 * Below 768px it is a read-only diagram + outline with "edit on a larger
 * screen". The store is created HERE, once per mount: the route keys this
 * component by flow id and the page keys it by customer, so a switch of
 * either starts a fresh store and history — nothing carries across.
 *
 * React #310: hooks first; the phone/desktop split is a child switch.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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
  Undo2,
  Wand2,
} from 'lucide-react';
import type { Flow } from '../types/ivr';
import { useIvrWorkspace } from '../pages/ivr/IvrContext';
import { useDestinations, usePrompts } from '../pages/ivr/ivrData';
import { formatWhen } from '../pages/ivr/format';
import { createFlowStore, FlowStoreContext, useFlow, useFlowStoreApi } from './store/flowStore';
import { FlowAnalysisContext, useFlowAnalysis, type FlowAnalysis } from './useFlowAnalysis';
import { BuilderDataContext, type BuilderData } from './BuilderData';
import { CanvasViewContext, type CanvasView } from './canvas/CanvasView';
import { FlowCanvas } from './canvas/FlowCanvas';
import { useAutosave, type Autosave, type SaveStatus } from './useAutosave';
import { useIsNarrow } from './useIsNarrow';
import { Palette } from './panels/Palette';
import { Outline } from './panels/Outline';
import { Inspector } from './panels/Inspector';
import { PublishPanel } from './panels/PublishPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { SimulatorPanel } from './panels/SimulatorPanel';
import { ConflictDialog } from './panels/ConflictDialog';
import { AddBlockMenu, type AddRequest } from './panels/AddBlockMenu';
import { blockTitle } from './model/summary';

export interface FlowBuilderProps {
  flow: Flow;
  maxBlocks?: number;
}

export function FlowBuilder({ flow, maxBlocks }: FlowBuilderProps) {
  // One store per mounted builder (see the header).
  const [store] = useState(() => createFlowStore(flow));
  return (
    <FlowStoreContext.Provider value={store}>
      <ReactFlowProvider>
        <BuilderShell maxBlocks={maxBlocks} />
      </ReactFlowProvider>
    </FlowStoreContext.Provider>
  );
}

type Sheet = 'publish' | 'history' | 'sim' | null;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function BuilderShell({ maxBlocks }: { maxBlocks?: number }) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const store = useFlowStoreApi();
  const narrow = useIsNarrow();
  const meta = useFlow((s) => s.meta);
  const preview = useFlow((s) => s.preview);
  const prompts = usePrompts(ws.scope);
  const destinations = useDestinations(ws.scope);
  const readOnly = !ws.canEdit;
  const autosave = useAutosave(store, ws.scope, readOnly);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [addRequest, setAddRequest] = useState<AddRequest | null>(null);

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
      readOnly: readOnly || preview !== null,
    }),
    [prompts.data, destinations.data, destinations.isLoading, destinations.isError, meta.numbers, readOnly, preview],
  );

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
    return {
      targets: analysis.targets,
      titleOf: analysis.titleOf,
      issuesByNode: analysis.issuesByNode,
      reachable: analysis.compiled.reachable,
      summary: analysis.summary,
      readOnly,
      onAddAfter: readOnly ? null : (source, handle) => setAddRequest({ source, handle }),
    };
  }, [preview, analysis, readOnly]);

  // Keyboard: undo / redo, Esc to deselect — never while typing in a field.
  useEffect(() => {
    if (readOnly || narrow) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.vm-dialog-root')) return;
      const mod = e.metaKey || e.ctrlKey;
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
          {narrow ? (
            <PhoneView autosave={autosave} />
          ) : (
            <div className="ivr-builder">
              <TopBar autosave={autosave} analysis={analysis} sheet={sheet} setSheet={setSheet} />
              <div className={`ivr-work${sheet ? ' ivr-work--sheet' : ''}`}>
                <LeftColumn readOnly={readOnly} previewing={preview !== null} />
                <div className="ivr-canvas-wrap">
                  {preview && <PreviewBanner onRestore={() => setSheet('history')} />}
                  <FlowCanvas mode={preview ? 'preview' : readOnly ? 'readonly' : 'edit'} override={preview} />
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
                  ) : (
                    <Inspector />
                  )}
                </aside>
              </div>
            </div>
          )}
          {autosave.status.kind === 'conflict' && (
            <ConflictDialog onLoadLatest={autosave.loadLatest} onKeepMine={autosave.keepMine} />
          )}
          {addRequest && <AddBlockMenu request={addRequest} onClose={() => setAddRequest(null)} />}
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
  sheet,
  setSheet,
}: {
  autosave: Autosave;
  analysis: FlowAnalysis;
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
  const readOnly = !ws.canEdit;
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
              disabled={!canUndo || preview}
              aria-label="Undo"
              title="Undo (⌘Z / Ctrl+Z)"
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ivr-tool"
              onClick={() => store.getState().redo()}
              disabled={!canRedo || preview}
              aria-label="Redo"
              title="Redo (⇧⌘Z / Ctrl+Y)"
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ivr-tool"
              onClick={() => store.getState().tidy()}
              disabled={preview}
              aria-label="Tidy up the layout"
              title="Tidy up the layout"
            >
              <Wand2 size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        <button type="button" className={`dl-btn dl-btn-ghost ivr-top-btn${sheet === 'sim' ? ' ivr-top-on' : ''}`} onClick={() => toggle('sim')} aria-pressed={sheet === 'sim'}>
          <FlaskConical size={15} aria-hidden="true" /> Test call
        </button>
        <button type="button" className={`dl-btn dl-btn-ghost ivr-top-btn${sheet === 'history' ? ' ivr-top-on' : ''}`} onClick={() => toggle('history')} aria-pressed={sheet === 'history'}>
          <History size={15} aria-hidden="true" /> History
        </button>
        {!readOnly && (
          <button type="button" className="dl-btn dl-btn-primary ivr-top-publish" onClick={() => toggle('publish')} aria-pressed={sheet === 'publish'}>
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

function LeftColumn({ readOnly, previewing }: { readOnly: boolean; previewing: boolean }) {
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
        {tab === 'blocks' ? <Palette disabled={readOnly || previewing} previewing={previewing} /> : <Outline />}
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

function PhoneView({ autosave }: { autosave: Autosave }) {
  const ws = useIvrWorkspace();
  const name = useFlow((s) => s.name);
  const meta = useFlow((s) => s.meta);
  const nodes = useFlow((s) => s.nodes.length);
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
      </div>
      <div className="ivr-phone-note">
        <MonitorSmartphone size={18} aria-hidden="true" />
        <p>
          <strong>Edit on a larger screen.</strong> On a phone you can read the flow; open it on a tablet or computer to
          change it.
        </p>
      </div>
      <div className="ivr-phone-canvas" style={{ '--ivr-phone-h': nodes > 6 ? '52vh' : '42vh' } as CSSProperties}>
        <FlowCanvas mode="readonly" compact />
      </div>
      <section className="ivr-phone-outline" aria-label="Flow outline">
        <h2 className="ivr-insp-h">The flow, step by step</h2>
        <Outline />
      </section>
    </div>
  );
}
