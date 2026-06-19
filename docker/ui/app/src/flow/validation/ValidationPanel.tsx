/**
 * Live validation panel. Recomputes `validateIvr` on every graph change and
 * lists the findings; clicking a finding selects the offending node so the
 * canvas + config panel focus it. Publish is blocked while any error remains
 * (enforced in the toolbar via the same `validateIvr`).
 *
 * React #310: store hooks unconditionally at the top.
 */
import { useFlowStore } from '../store/flowStore';
import { validateIvr } from '../compile/ivr';

export function ValidationPanel() {
  // Subscribe to graph slices so this recomputes on any structural change.
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const getDoc = useFlowStore((s) => s.getDoc);
  const setSelected = useFlowStore((s) => s.setSelected);

  // `nodes`/`edges` are referenced so the memo/recompute tracks them.
  void nodes;
  void edges;
  const { issues } = validateIvr(getDoc());

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <span style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#4a5568' }}>
          Validation
        </span>
        <span style={{ display: 'flex', gap: 8, fontSize: '0.7rem', fontWeight: 700 }}>
          <span style={{ color: errors.length ? '#ef4444' : '#22c55e' }}>{errors.length} err</span>
          <span style={{ color: warnings.length ? '#f59e0b' : '#64748b' }}>{warnings.length} warn</span>
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
        {issues.length === 0 ? (
          <div style={{ fontSize: '0.76rem', color: '#22c55e', padding: 6 }}>
            ✓ No issues — ready to publish.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {issues.map((issue, i) => {
              const color = issue.severity === 'error' ? '#ef4444' : '#f59e0b';
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => issue.nodeId && setSelected(issue.nodeId)}
                  style={{
                    display: 'flex',
                    gap: 8,
                    textAlign: 'left',
                    padding: '7px 9px',
                    borderRadius: 8,
                    fontSize: '0.72rem',
                    color: '#cbd5e1',
                    background: 'rgba(26,29,39,0.9)',
                    border: `1px solid ${color}44`,
                    cursor: issue.nodeId ? 'pointer' : 'default',
                  }}
                >
                  <span style={{ color, fontWeight: 800, flexShrink: 0 }}>
                    {issue.severity === 'error' ? '✕' : '!'}
                  </span>
                  <span>{issue.message}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
