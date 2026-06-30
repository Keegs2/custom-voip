/**
 * RecentCallsCard — the user's recent call log in a frosted glass table, or an
 * empty state when there are none.
 */

import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { fmt, fmtDuration } from '../../../../utils/format';
import { fmtTimestamp } from '../helpers';
import { CALL_RESULT_COLOR } from '../constants';
import type { RecentCall } from '../types';
import { MONO, tableTd, tableTh, tableHeadRow, statusPill } from '../styles';
import { SectionCard } from './SectionCard';
import { IconInbound, IconOutbound, IconPhone } from './icons';

interface RecentCallsCardProps {
  calls: RecentCall[];
}

export function RecentCallsCard({ calls }: RecentCallsCardProps) {
  if (calls.length === 0) {
    return (
      <SectionCard accent={GLASS.textFaint} title="Recent Calls" icon={<IconPhone size={16} />}>
        <div style={{ padding: '20px 0', textAlign: 'center', color: GLASS.textMuted, fontSize: '0.82rem', fontStyle: 'italic' }}>
          No recent calls found for this user.
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard accent="#0ea5e9" title={`Recent Calls (${calls.length})`} icon={<IconPhone size={16} />}>
      <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={tableHeadRow}>
              {['Dir', 'Caller', '', 'Callee', 'Duration', 'Result', 'Time'].map((col, i) => (
                <th key={`${col}-${i}`} style={tableTh}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => {
              const resultColor = CALL_RESULT_COLOR[call.result] ?? GLASS.textMuted;
              const inbound = call.direction === 'inbound';
              const dirColor = inbound ? '#0ea5e9' : '#a855f7';
              return (
                <tr key={call.id}>
                  <td style={{ ...tableTd, width: 40 }}>
                    <span
                      title={call.direction}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: hexToRgba(dirColor, 0.12),
                        color: dirColor,
                      }}
                    >
                      {inbound ? <IconInbound /> : <IconOutbound />}
                    </span>
                  </td>
                  <td style={{ ...tableTd, fontFamily: MONO, color: '#cbd5e0' }}>{fmt(call.caller)}</td>
                  <td style={{ ...tableTd, color: GLASS.textFaint, padding: '11px 4px' }}>→</td>
                  <td style={{ ...tableTd, fontFamily: MONO, color: '#cbd5e0' }}>{fmt(call.callee)}</td>
                  <td style={{ ...tableTd, color: GLASS.textMuted, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {call.duration > 0 ? fmtDuration(call.duration) : '—'}
                  </td>
                  <td style={{ ...tableTd, textAlign: 'center' }}>
                    <span style={statusPill(resultColor)}>{call.result}</span>
                  </td>
                  <td style={{ ...tableTd, color: GLASS.textMuted, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {fmtTimestamp(call.timestamp)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
