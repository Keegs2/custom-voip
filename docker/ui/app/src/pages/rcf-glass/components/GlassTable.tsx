/**
 * GlassTable — the compact, dense view of RCF lines inside a frosted panel.
 * Each row's destination is editable via the shared <ForwardToEditor>.
 */

import type { RcfEntry } from '../../../types/rcf';
import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { fmt } from '../../../utils/format';
import { StatusChip } from './StatusChip';
import { ForwardToEditor } from './ForwardToEditor';
import { MONO, th, td } from '../styles';

interface GlassTableProps {
  entries: RcfEntry[];
  canEdit: boolean;
  isAdmin: boolean;
}

export function GlassTable({ entries, canEdit, isAdmin }: GlassTableProps) {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
              <th style={th}>Status</th>
              <th style={th}>DID</th>
              {isAdmin && <th style={th}>Customer</th>}
              <th style={th}>Forwards To</th>
              <th style={th}>Ring</th>
              <th style={th}>Caller ID</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={td}><StatusChip enabled={e.enabled} /></td>
                <td style={{ ...td, fontFamily: MONO, fontWeight: 700 }}>
                  {fmt(e.did)}
                  {e.name && (
                    <div style={{ fontSize: '0.66rem', color: GLASS.textMuted, fontFamily: 'inherit', fontWeight: 500, marginTop: 2 }}>
                      {e.name}
                    </div>
                  )}
                </td>
                {isAdmin && <td style={{ ...td, color: GLASS.textMuted }}>{e.customer_name ?? '—'}</td>}
                <td style={td}><ForwardToEditor entry={e} canEdit={canEdit} size="sm" /></td>
                <td style={{ ...td, color: GLASS.textMuted }}>{e.ring_timeout ?? 30}s</td>
                <td style={td}>
                  <GlassChip label={e.pass_caller_id ? 'Pass-thru' : 'Show DID'} color={e.pass_caller_id ? GLASS.accent : GLASS.textMuted} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
