/**
 * ExitList — every exit of the selected block with a "Goes to…" menu: an
 * existing block, a NEW block (created and connected in one step), or
 * nothing (the call ends there). A plain <select>, so wiring a whole flow
 * needs no mouse. Choices that would loop back or enter Start are listed
 * but disabled, with the reason in the option text.
 */
import { useId } from 'react';
import { BLOCKS, PALETTE_TYPES, outHandles } from '../model/blocks';
import { blockTitle, summarizeBlock } from '../model/summary';
import { connectionProblem, useFlow, useFlowStoreApi, type FlowNode } from '../store/flowStore';
import { useAnalysis } from '../useFlowAnalysis';
import { isIvrNodeType } from '../model/blocks';

const NEW_PREFIX = 'new:';

/** "Sales (Transfer)" for a named block, "Transfer — Sales line · (617)…" for an unnamed one. */
function optionText(o: FlowNode, summary: Parameters<typeof summarizeBlock>[1]): string {
  if (o.data.label?.trim()) return `${blockTitle(o)} (${BLOCKS[o.type].label})`;
  const s = summarizeBlock(o, summary);
  return `${BLOCKS[o.type].label} — ${s.length > 44 ? `${s.slice(0, 43)}…` : s}`;
}

export function ExitList({ node, readOnly }: { node: FlowNode; readOnly: boolean }) {
  // ── Hooks first (React #310) ──
  const store = useFlowStoreApi();
  const nodes = useFlow((s) => s.nodes);
  const edges = useFlow((s) => s.edges);
  const analysis = useAnalysis();
  const baseId = useId();

  const exits = outHandles(node);
  if (exits.length === 0) return null;
  const others = nodes.filter((n) => n.id !== node.id && n.type !== 'entry');

  return (
    <section className="ivr-insp-section" aria-labelledby={`${baseId}-title`}>
      <h3 id={`${baseId}-title`} className="ivr-insp-h">
        {exits.length === 1 ? 'Then' : 'Where each choice goes'}
      </h3>
      <ul className="ivr-exitlist">
        {exits.map((h) => {
          const target = analysis.targets.get(`${node.id}\u0000${h.id}`) ?? '';
          const issue = analysis.issuesByNode.get(node.id)?.find((i) => i.handle === h.id);
          const selectId = `${baseId}-${h.id}`;
          return (
            <li key={h.id} className={`ivr-exitrow${issue?.severity === 'error' ? ' ivr-exitrow-error' : ''}`}>
              <label className="ivr-exitrow-label" htmlFor={selectId}>
                {h.digit ? <span className="ivr-key">{h.digit}</span> : <span className="ivr-exit-mark" aria-hidden="true" />}
                {h.digit ? `Press ${h.digit}` : h.label}
              </label>
              {readOnly ? (
                <span className="ivr-exitrow-ro">{target ? analysis.titleOf(target) : 'Ends the call'}</span>
              ) : (
                <select
                  id={selectId}
                  className="dl-input ivr-exitrow-select"
                  value={target}
                  onChange={(e) => {
                    const v = e.target.value;
                    const s = store.getState();
                    if (v === '') s.disconnect(node.id, h.id);
                    else if (v.startsWith(NEW_PREFIX)) {
                      const type = v.slice(NEW_PREFIX.length);
                      if (isIvrNodeType(type)) s.addBlock(type, { from: { source: node.id, handle: h.id } });
                    } else s.connect(node.id, h.id, v);
                  }}
                >
                  <option value="">Nothing — the call ends</option>
                  {others.length > 0 && (
                    <optgroup label="Go to a block">
                      {others.map((o) => {
                        const problem = o.id === target ? null : connectionProblem(nodes, edges, node.id, h.id, o.id);
                        return (
                          <option key={o.id} value={o.id} disabled={problem !== null}>
                            {optionText(o, analysis.summary)}
                            {problem ? ' — would loop; use Go to' : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                  <optgroup label="Add a new block">
                    {PALETTE_TYPES.map((t) => (
                      <option key={t} value={`${NEW_PREFIX}${t}`}>
                        New {BLOCKS[t].label}
                      </option>
                    ))}
                  </optgroup>
                </select>
              )}
              {issue && <p className={`ivr-exitrow-msg ivr-exitrow-msg-${issue.severity}`}>{issue.message}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
