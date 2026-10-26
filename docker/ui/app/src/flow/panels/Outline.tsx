/**
 * Outline — the flow as a text tree, in call order. Each row is the choice
 * that leads there ("1", "Open", "No answer or busy") followed by the block
 * it reaches, as a button (select + centre it), so the whole flow can be
 * read and edited by keyboard or screen reader without the canvas. A block
 * reached a second time (a loop, a shared voicemail) is a link back, not a
 * repeat; blocks callers never reach are listed last.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { IvrConfigMap } from '../../types/ivr';
import { outHandles, type OutHandle } from '../model/blocks';
import { blockTitle } from '../model/summary';
import { useFlow, useFlowStoreApi, type FlowNode } from '../store/flowStore';
import { BlockIcon } from '../canvas/BlockIcon';
import { useCanvasView } from '../canvas/CanvasView';

/** A key press sits inline as a keycap; any other choice is a caption line above its block. */
function Via({ via }: { via: OutHandle | null }) {
  if (!via?.digit) return null;
  return (
    <span className="ivr-key ivr-ol-key" aria-label={`Press ${via.digit}`}>
      {via.digit}
    </span>
  );
}

function Caption({ via }: { via: OutHandle | null }) {
  if (!via || via.digit) return null;
  return <span className="ivr-ol-cap">{via.label}</span>;
}

/**
 * `nodes`: a read-only overlay's blocks (a published version or a Flow
 * assistant proposal) — the outline then reads the overlay, and choosing a
 * block only centres it (there is nothing to select or edit).
 */
export function Outline({ nodes: override }: { nodes?: readonly FlowNode[] }) {
  // ── Hooks first (React #310) ──
  const store = useFlowStoreApi();
  const draft = useFlow((s) => s.nodes);
  const selectedId = useFlow((s) => s.selectedId);
  const view = useCanvasView();
  const nodes = override ?? draft;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = nodes.find((n) => n.type === 'entry');
  const seen = new Set<string>();

  const pick = (id: string) => (override ? store.getState().revealBlock(id) : store.getState().focusBlock(id));

  const item = (node: FlowNode, via: OutHandle | null, depth: number): ReactNode => {
    seen.add(node.id);
    const issues = view.issuesByNode.get(node.id) ?? [];
    const bad = issues.some((i) => i.severity === 'error');
    const exits = outHandles(node);
    const jump = node.type === 'goto' ? (node.data.config as IvrConfigMap['goto']).targetNodeId : '';
    const children: ReactNode[] = [];
    if (depth < 40) {
      for (const h of exits) {
        const t = view.targets.get(`${node.id}\u0000${h.id}`);
        const target = t ? byId.get(t) : undefined;
        if (!target) {
          children.push(
            <li key={h.id} className="ivr-ol-item ivr-ol-end">
              <Caption via={h} />
              <span className="ivr-ol-row">
                <Via via={h} />
                <span>ends the call</span>
              </span>
            </li>,
          );
        } else if (seen.has(target.id)) {
          children.push(
            <li key={h.id} className="ivr-ol-item">
              <Caption via={h} />
              <span className="ivr-ol-row">
                <Via via={h} />
                <button type="button" className="ivr-ol-back" onClick={() => pick(target.id)}>
                  ↑ {blockTitle(target)}
                </button>
              </span>
            </li>,
          );
        } else {
          children.push(item(target, h, depth + 1));
        }
      }
    }
    return (
      <li key={node.id} className="ivr-ol-item">
        <Caption via={via} />
        <span className="ivr-ol-row">
          <Via via={via} />
          <button
            type="button"
            className={`ivr-ol-block${selectedId === node.id ? ' ivr-ol-on' : ''}${bad ? ' ivr-ol-bad' : ''}`}
            style={{ '--ivr-hue': `var(--ivr-${node.type})` } as CSSProperties}
            onClick={() => pick(node.id)}
            title={node.type === 'entry' ? 'Start' : blockTitle(node)}
            aria-current={selectedId === node.id ? 'true' : undefined}
          >
            <span className="ivr-ol-icon">
              <BlockIcon type={node.type} size={13} />
            </span>
            <span className="ivr-ol-title">{node.type === 'entry' ? 'Start' : blockTitle(node)}</span>
            {bad && <span className="ivr-ol-flag">Fix</span>}
          </button>
        </span>
        {node.type === 'goto' && (
          <p className="ivr-ol-jump">↩ {jump && byId.has(jump) ? `back to ${blockTitle(byId.get(jump) as FlowNode)}` : 'not set'}</p>
        )}
        {children.length > 0 && <ul className="ivr-ol-tree ivr-ol-nested">{children}</ul>}
      </li>
    );
  };

  const tree = start ? item(start, null, 0) : null;
  const orphans = nodes.filter((n) => !seen.has(n.id));

  return (
    <div className="ivr-outline">
      <p className="ivr-side-hint">The flow in call order. Select a block to open its settings.</p>
      <ul className="ivr-ol-tree ivr-ol-root" aria-label="Flow outline">
        {tree}
      </ul>
      {orphans.length > 0 && (
        <>
          <h3 className="ivr-pal-h">Not connected</h3>
          {/* Sequential: an orphan already drawn inside another orphan's branch is skipped. */}
          <ul className="ivr-ol-tree">{orphans.map((n) => (seen.has(n.id) ? null : item(n, null, 0)))}</ul>
        </>
      )}
    </div>
  );
}
