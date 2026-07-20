/**
 * QueueMembersPanel — the drill-in roster of callers waiting in one queue.
 * Polls `useQueueMembers`. React #310: the query hook is called before any
 * early return.
 */

import { GLASS } from '../../../../components/glass/glass';
import { GlassTable } from '../../shared/GlassTable';
import { GlassSpinnerRow } from '../../shared/states';
import { th, thRight, td, tdMono, tdNum, theadRow } from '../../shared/styles';
import { useQueueMembers, memberLabel, fmtWait } from '../hooks';

export function QueueMembersPanel({ name }: { name: string }) {
  // Hook first — before any early return (React #310).
  const { data, isLoading, isError } = useQueueMembers(name);

  if (isLoading) return <GlassSpinnerRow label="Loading members…" />;
  if (isError || !data) {
    return <div style={{ padding: '16px 4px', fontSize: '0.85rem', color: GLASS.danger }}>Failed to load queue members.</div>;
  }
  if (data.members.length === 0) {
    return <div style={{ padding: '16px 4px', fontSize: '0.85rem', color: GLASS.textFaint }}>No callers waiting in this queue.</div>;
  }

  return (
    <div style={{ paddingTop: 8 }}>
      <GlassTable
        head={
          <thead>
            <tr style={theadRow}>
              <th style={th}>Caller</th>
              <th style={th}>Destination</th>
              <th style={th}>State</th>
              <th style={thRight}>Waiting</th>
            </tr>
          </thead>
        }
      >
        {data.members.map((m, i) => (
          <tr key={m.uuid ?? `${memberLabel(m)}-${i}`}>
            <td style={{ ...tdMono, color: GLASS.text }}>{memberLabel(m)}</td>
            <td style={tdMono}>{m.dest ?? '—'}</td>
            <td style={{ ...td, color: GLASS.textMuted, fontSize: '0.78rem' }}>{m.state ?? '—'}</td>
            <td style={tdNum}>{fmtWait(m.wait_ms)}</td>
          </tr>
        ))}
      </GlassTable>
    </div>
  );
}
