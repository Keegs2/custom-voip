/**
 * BlockNode — every IVR block on the canvas. One card shape for all nine
 * types, coloured by its `--ivr-<type>` hue:
 *
 *   ┌───────────────────────────────┐
 *   ●  [icon] Menu                ⚠ │  ← target handle (left), kind, findings
 *   │  Main menu                    │  ← the block's name
 *   │  Plays “Main menu options”…   │  ← plain-English summary
 *   ├───────────────────────────────┤
 *   │  [1] Press 1   → Sales      ● │  ← one row per exit, its handle on the right,
 *   │  [9] Press 9   → Repeat     ● │    where it leads (or "Not connected")
 *   │      No key    → Repeat     ● │
 *   └───────────────────────────────┘
 *
 * A menu's keys are drawn as keypad keycaps — the canvas's one flourish.
 * React #310: hooks first, no early returns.
 */
import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { CircleAlert, Plus, TriangleAlert } from 'lucide-react';
import { BLOCKS, outHandles } from '../model/blocks';
import { blockTitle, summarizeBlock } from '../model/summary';
import { useFlow, type FlowNode } from '../store/flowStore';
import { BlockIcon } from './BlockIcon';
import { useCanvasView } from './CanvasView';

function BlockNodeImpl({ id, type, data, selected }: NodeProps<FlowNode>) {
  // ── Hooks first (React #310) ──
  const view = useCanvasView();
  const simOn = useFlow((s) => s.simNodeId === id);

  const meta = BLOCKS[type];
  const node = { id, type, data };
  const exits = outHandles(node);
  const issues = view.issuesByNode.get(id) ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const unreachable = view.reachable !== null && type !== 'entry' && !view.reachable.has(id);
  const title = blockTitle(node);
  const named = Boolean(data.label?.trim());
  const summary = summarizeBlock(node, view.summary);
  const mark = view.marks?.get(id) ?? null;

  const className = [
    'ivr-node',
    `ivr-node--${type}`,
    selected && 'ivr-node--selected',
    errors.length > 0 && 'ivr-node--error',
    unreachable && 'ivr-node--unreachable',
    simOn && 'ivr-node--sim',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} style={{ '--ivr-hue': `var(--ivr-${type})`, '--ivr-ink': `var(--ivr-${type}-ink)` } as CSSProperties}>
      {type !== 'entry' && <Handle type="target" id="in" position={Position.Left} className="ivr-handle ivr-handle-in" />}

      <div className="ivr-node-head">
        <span className="ivr-node-icon">
          <BlockIcon type={type} size={15} />
        </span>
        <span className="ivr-node-kind">{meta.label}</span>
        {mark && <span className={`ivr-node-mark ivr-node-mark--${mark}`}>{mark === 'new' ? 'New' : 'Changed'}</span>}
        {errors.length > 0 ? (
          <span className="ivr-node-flag ivr-node-flag-err" title={errors.map((e) => e.message).join('\n')}>
            <CircleAlert size={14} aria-hidden="true" />
            <span className="ivr-sr">{errors.length === 1 ? '1 problem' : `${errors.length} problems`}</span>
            {errors.length > 1 && <span aria-hidden="true">{errors.length}</span>}
          </span>
        ) : warnings.length > 0 ? (
          <span className="ivr-node-flag ivr-node-flag-warn" title={warnings.map((w) => w.message).join('\n')}>
            <TriangleAlert size={13} aria-hidden="true" />
            <span className="ivr-sr">{warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}</span>
          </span>
        ) : null}
      </div>

      <div className="ivr-node-body">
        {(named || type === 'entry') && <div className="ivr-node-title">{type === 'entry' ? 'Call starts' : title}</div>}
        <p className="ivr-node-summary">{summary}</p>
        {unreachable && <p className="ivr-node-note">Not connected — callers never reach this block.</p>}
      </div>

      {exits.length > 0 && (
        <ul className="ivr-exits">
          {exits.map((h) => {
            const target = view.targets.get(`${id}\u0000${h.id}`);
            const exitIssue = issues.find((i) => i.handle === h.id);
            return (
              <li
                key={h.id}
                className={[
                  'ivr-exit',
                  `ivr-exit--${h.kind}`,
                  !target && 'ivr-exit--open',
                  exitIssue?.severity === 'error' && 'ivr-exit--error',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {h.digit ? (
                  <span className="ivr-key" aria-hidden="true">
                    {h.digit}
                  </span>
                ) : (
                  <span className="ivr-exit-mark" aria-hidden="true" />
                )}
                {!h.digit && <span className="ivr-exit-label">{h.label}</span>}
                {h.digit && <span className="ivr-sr">Press {h.digit}</span>}
                <span className={`ivr-exit-to${h.digit ? ' ivr-exit-to-key' : ''}`}>
                  {target ? (
                    <>
                      {!h.digit && <span aria-hidden="true">→ </span>}
                      {view.titleOf(target)}
                    </>
                  ) : view.onAddAfter && !view.readOnly ? (
                    <button
                      type="button"
                      className="ivr-exit-add nodrag"
                      onClick={(e) => {
                        e.stopPropagation();
                        view.onAddAfter?.(id, h.id);
                      }}
                      aria-label={`Add a block after ${title}: ${h.label}`}
                    >
                      <Plus size={11} aria-hidden="true" /> Add
                    </button>
                  ) : (
                    'Ends call'
                  )}
                </span>
                <Handle type="source" id={h.id} position={Position.Right} className="ivr-handle ivr-handle-out" />
              </li>
            );
          })}
        </ul>
      )}

      {/* Go to jump lines run underneath: out of the Go to's bottom, into the target's bottom. */}
      {type === 'goto' && (
        <Handle type="source" id="jump" position={Position.Bottom} className="ivr-handle ivr-handle-jump" isConnectable={false} />
      )}
      {type !== 'entry' && (
        <Handle type="target" id="jumpin" position={Position.Bottom} className="ivr-handle ivr-handle-jump" isConnectable={false} />
      )}
    </div>
  );
}

export const BlockNode = memo(BlockNodeImpl);
