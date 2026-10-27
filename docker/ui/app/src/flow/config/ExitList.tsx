/**
 * ExitList — every exit of the selected block with a "Goes to…" menu: an
 * existing block, a NEW block (created and connected in one step), or
 * nothing (the call ends there). A Select (the app's themed dropdown, full
 * keyboard support), so wiring a whole flow needs no mouse. Choices that
 * would loop back or enter Start are listed but disabled, with the reason
 * as the row's hint.
 */
import { useId } from 'react';
import { Select, type SelectOption } from '../../components/ui/Select';
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

/** The "Add a new block" group — the same for every exit. */
const NEW_BLOCK_OPTIONS: readonly SelectOption[] = PALETTE_TYPES.map((t) => ({
  value: `${NEW_PREFIX}${t}`,
  label: `New ${BLOCKS[t].label}`,
  group: 'Add a new block',
}));

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
                <Select
                  id={selectId}
                  // `nokey`: React Flow ignores Delete / Backspace while it has focus (a native select was an input to it).
                  className="dl-input ivr-exitrow-select nokey"
                  value={target}
                  onChange={(v) => {
                    const s = store.getState();
                    if (v === '') s.disconnect(node.id, h.id);
                    else if (v.startsWith(NEW_PREFIX)) {
                      const type = v.slice(NEW_PREFIX.length);
                      if (isIvrNodeType(type)) s.addBlock(type, { from: { source: node.id, handle: h.id } });
                    } else s.connect(node.id, h.id, v);
                  }}
                  options={[
                    { value: '', label: 'Nothing — the call ends' },
                    ...others.map((o): SelectOption => {
                      const problem = o.id === target ? null : connectionProblem(nodes, edges, node.id, h.id, o.id);
                      return {
                        value: o.id,
                        label: optionText(o, analysis.summary),
                        hint: problem ? 'Would loop — use Go to' : undefined,
                        disabled: problem !== null,
                        group: 'Go to a block',
                      };
                    }),
                    ...NEW_BLOCK_OPTIONS,
                  ]}
                  searchPlaceholder="Search blocks…"
                />
              )}
              {issue && <p className={`ivr-exitrow-msg ivr-exitrow-msg-${issue.severity}`}>{issue.message}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
