/**
 * Inspector — the right-hand panel. With a block selected (by click, by
 * keyboard — Tab to a block, Enter — from the outline or an issue link) it
 * is that block's settings: name, the type's form, where each exit goes and
 * its findings. With nothing selected it is the flow's checklist.
 */
import { useId, type CSSProperties, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Loader2, Trash2, TriangleAlert, X } from 'lucide-react';
import type { IvrConfigMap, IvrNodeType } from '../../types/ivr';
import { fmt } from '../../utils/format';
import { BLOCKS } from '../model/blocks';
import { useFlow, useFlowStoreApi, type FlowNode } from '../store/flowStore';
import { useAnalysis, type ShownIssue } from '../useFlowAnalysis';
import { useBuilderData } from '../BuilderData';
import { BlockIcon } from '../canvas/BlockIcon';
import { ExitList } from '../config/ExitList';
import { PanelChromeButtons } from './PanelChromeButtons';
import {
  ConditionForm,
  DialForm,
  GotoForm,
  HangupForm,
  MenuForm,
  PlayForm,
  ScheduleForm,
  VoicemailForm,
} from '../config/BlockForms';

export function Inspector() {
  const selectedId = useFlow((s) => s.selectedId);
  const node = useFlow((s) => (s.selectedId ? s.nodes.find((n) => n.id === s.selectedId) ?? null : null));
  return node ? <BlockPanel key={selectedId ?? ''} node={node} /> : <FlowChecklist />;
}

/* ─── One block ───────────────────────────────────────────── */

function BlockPanel({ node }: { node: FlowNode }) {
  // ── Hooks first (React #310) ──
  const store = useFlowStoreApi();
  const { readOnly } = useBuilderData();
  const analysis = useAnalysis();
  const nameId = useId();

  const meta = BLOCKS[node.type];
  const issues = (analysis.issuesByNode.get(node.id) ?? []).filter((i) => !i.handle);
  const update = <T extends IvrNodeType>(patch: Partial<IvrConfigMap[T]>, key?: string) =>
    store.getState().updateConfig<T>(node.id, patch, key);
  const props = { node, readOnly };

  let form: ReactNode = null;
  switch (node.type) {
    case 'entry':
      form = <p className="ivr-insp-copy">Every call to this flow’s numbers starts here. Connect it to the first thing callers hear.</p>;
      break;
    case 'play':
      form = <PlayForm {...props} config={node.data.config as IvrConfigMap['play']} update={update<'play'>} />;
      break;
    case 'menu':
      form = <MenuForm {...props} config={node.data.config as IvrConfigMap['menu']} update={update<'menu'>} />;
      break;
    case 'schedule':
      form = <ScheduleForm {...props} config={node.data.config as IvrConfigMap['schedule']} update={update<'schedule'>} />;
      break;
    case 'condition':
      form = <ConditionForm {...props} config={node.data.config as IvrConfigMap['condition']} update={update<'condition'>} />;
      break;
    case 'dial':
      form = <DialForm {...props} config={node.data.config as IvrConfigMap['dial']} update={update<'dial'>} />;
      break;
    case 'voicemail':
      form = <VoicemailForm {...props} config={node.data.config as IvrConfigMap['voicemail']} update={update<'voicemail'>} />;
      break;
    case 'goto':
      form = <GotoForm {...props} config={node.data.config as IvrConfigMap['goto']} update={update<'goto'>} />;
      break;
    case 'hangup':
      form = <HangupForm {...props} config={node.data.config as IvrConfigMap['hangup']} update={update<'hangup'>} />;
      break;
  }

  return (
    <div
      className="ivr-insp"
      style={{ '--ivr-hue': `var(--ivr-${node.type})`, '--ivr-ink': `var(--ivr-${node.type}-ink)` } as CSSProperties}
      aria-label={`${meta.label} settings`}
      role="region"
    >
      <div className="ivr-insp-head">
        <span className="ivr-insp-icon">
          <BlockIcon type={node.type} size={17} />
        </span>
        <div className="ivr-insp-titles">
          <span className="ivr-insp-kind">{meta.label}</span>
          <span className="ivr-insp-desc">{meta.description}</span>
        </div>
        <PanelChromeButtons />
        <button
          type="button"
          className="vm-iconbtn"
          aria-label="Close block settings"
          title="Close (Esc)"
          onClick={() => store.getState().select(null)}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="ivr-insp-body">
        {node.type !== 'entry' && (
          <div className="ivr-field">
            <label className="ivr-label" htmlFor={nameId}>
              Block name
            </label>
            <input
              id={nameId}
              className="dl-input vm-input-full"
              value={node.data.label ?? ''}
              placeholder={meta.label}
              maxLength={60}
              disabled={readOnly}
              onChange={(e) => store.getState().setLabel(node.id, e.target.value)}
            />
            <p className="dl-help">Only you see it — it labels the block on the canvas and in menus.</p>
          </div>
        )}
        {form}
        {issues.length > 0 && <IssueList issues={issues} />}
        <ExitList node={node} readOnly={readOnly} />
      </div>

      {!readOnly && node.type !== 'entry' && (
        <div className="ivr-insp-foot">
          <button
            type="button"
            className="dl-btn dl-btn-danger ivr-btn-sm"
            onClick={() => store.getState().removeBlocks([node.id])}
          >
            <Trash2 size={14} aria-hidden="true" /> Delete block
          </button>
          <span className="ivr-insp-hint">Undo with ⌘Z / Ctrl+Z</span>
        </div>
      )}
    </div>
  );
}

function IssueList({ issues, onPick }: { issues: readonly ShownIssue[]; onPick?: (nodeId: string) => void }) {
  const analysis = useAnalysis();
  return (
    <ul className="ivr-issues">
      {issues.map((i, k) => {
        const body = (
          <>
            {i.severity === 'error' ? (
              <CircleAlert size={14} className="ivr-issue-ic" aria-hidden="true" />
            ) : (
              <TriangleAlert size={14} className="ivr-issue-ic" aria-hidden="true" />
            )}
            <span>
              {onPick && i.nodeId && <strong className="ivr-issue-where">{analysis.titleOf(i.nodeId)}: </strong>}
              {i.message}
            </span>
          </>
        );
        return (
          <li key={`${i.code}-${i.nodeId ?? ''}-${i.handle ?? ''}-${k}`} className={`ivr-issue ivr-issue-${i.severity}`}>
            {onPick && i.nodeId ? (
              <button type="button" className="ivr-issue-btn" onClick={() => onPick(i.nodeId as string)}>
                {body}
              </button>
            ) : (
              <div className="ivr-issue-btn">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ─── Nothing selected: the flow checklist ────────────────── */

function FlowChecklist() {
  const store = useFlowStoreApi();
  const analysis = useAnalysis();
  const { ownDids, readOnly } = useBuilderData();
  const blocks = useFlow((s) => s.nodes.length);
  const errors = analysis.issues.filter((i) => i.severity === 'error');
  const warnings = analysis.issues.filter((i) => i.severity === 'warning');
  const pick = (id: string) => store.getState().focusBlock(id);

  return (
    <div className="ivr-insp ivr-insp-overview" role="region" aria-label="Flow checklist">
      <div className="ivr-insp-head">
        <div className="ivr-insp-titles">
          <span className="ivr-insp-kind">Checklist</span>
          <span className="ivr-insp-desc">
            {readOnly ? 'Select a block to see its settings.' : 'Select a block to edit it, or drag one in from the left.'}
          </span>
        </div>
        <PanelChromeButtons />
      </div>
      <div className="ivr-insp-body">
        <div className={`ivr-verdict ivr-verdict-${errors.length ? 'error' : warnings.length ? 'warning' : 'ok'}`}>
          {errors.length ? (
            <CircleAlert size={18} aria-hidden="true" />
          ) : warnings.length ? (
            <TriangleAlert size={18} aria-hidden="true" />
          ) : (
            <CircleCheck size={18} aria-hidden="true" />
          )}
          <div>
            <p className="ivr-verdict-title">
              {readOnly
                ? errors.length
                  ? `${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} in this draft`
                  : 'No problems found'
                : errors.length
                  ? `${errors.length} ${errors.length === 1 ? 'thing' : 'things'} to fix before publishing`
                  : warnings.length
                    ? 'Ready to publish, with notes'
                    : 'Ready to publish'}
            </p>
            <p className="ivr-verdict-sub">
              {analysis.server === 'checking' ? (
                <>
                  <Loader2 size={12} className="ivr-spin-ic" aria-hidden="true" /> Checking with Granite…
                </>
              ) : analysis.server === 'current' ? (
                'Checked by Granite just now.'
              ) : analysis.server === 'unavailable' ? (
                'Checked in your browser — the full check runs when you publish.'
              ) : (
                'Checked in your browser.'
              )}
            </p>
          </div>
        </div>
        {errors.length > 0 && <IssueList issues={errors} onPick={pick} />}
        {warnings.length > 0 && (
          <>
            <h3 className="ivr-insp-h">Notes</h3>
            <IssueList issues={warnings} onPick={pick} />
          </>
        )}
        <h3 className="ivr-insp-h">Answers calls on</h3>
        {ownDids.length ? (
          <ul className="ivr-answers">
            {ownDids.map((d) => (
              <li key={d}>{fmt(d)}</li>
            ))}
          </ul>
        ) : (
          <p className="ivr-insp-copy">No number uses this flow yet. Choose it for a number on the IVR page.</p>
        )}
        <h3 className="ivr-insp-h">Tips</h3>
        <ul className="ivr-tips">
          <li>Connect a block by dragging from an exit’s dot, or use its “Where each choice goes” menu.</li>
          <li>To repeat the menu, add a Go to block that points back to it.</li>
          <li>Run a Test call to hear the flow before you publish. {blocks > 1 ? '' : 'Start by adding a Play message.'}</li>
        </ul>
      </div>
    </div>
  );
}
