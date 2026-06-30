/**
 * ResultsTable — the dense per-call results grid. Each row is one correlated
 * call (A-leg + B-leg merged). Clicking a row expands an inline <SipLadder> plus
 * a Grafana deep link scoped to that call's Call-IDs. Owns only the expanded-row
 * index (purely view state).
 */

import { Fragment, useState } from 'react';
import { SipLadder } from '../../../components/sip-ladder';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import type { CallGroup } from '../types';
import { displayUser, fmtDateTime } from '../format';
import { StatusBadge, MsgCountBadge, DurationBadge } from './badges';
import { IconExternal } from './icons';
import { th, td, tdMono, tableRow, grafanaLink } from '../styles';

interface ResultsTableProps {
  callGroups: CallGroup[];
  correlations: Record<string, string[]>;
  /** Pipeline diagnostics from the API — surfaced above each expanded ladder. */
  pipelineWarnings: string[];
  startTime: string;
  endTime: string;
}

/** Build the Grafana deep link for one call group, scoped to its Call-IDs. */
function buildGrafanaLink(group: CallGroup, startTime: string, endTime: string): string {
  // Scope the deep link to exactly this call's SIP messages by passing ALL
  // correlated Call-IDs (A-leg + B-leg) as a regex OR pattern.
  const callIdPattern = group.callIds.join('|');

  // Gather timestamps from ALL messages in this call group for the time window.
  const callTimestamps = group.messages
    .map((r) => r.timestamp_ns)
    .filter((ts): ts is number => typeof ts === 'number' && ts > 0);

  let fromMs: number;
  let toMs: number;
  if (callTimestamps.length > 0) {
    // 5 s before first message, 60 s after last (B-leg may outlive A-leg).
    fromMs = Math.floor(Math.min(...callTimestamps) / 1_000_000) - 5_000;
    toMs = Math.floor(Math.max(...callTimestamps) / 1_000_000) + 60_000;
  } else {
    // Fallback: use the search form's time range.
    fromMs = Math.floor(new Date(startTime).getTime());
    toMs = Math.floor(new Date(endTime).getTime());
  }

  const params = new URLSearchParams({
    'var-callid': callIdPattern,
    from: String(fromMs),
    to: String(toMs),
    kiosk: 'tv',
  });
  return `/grafana/d/sip-search/sip-search?${params.toString()}`;
}

export function ResultsTable({ callGroups, correlations, pipelineWarnings, startTime, endTime }: ResultsTableProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Time</th>
            <th style={th}>From</th>
            <th style={th}>To</th>
            <th style={th}>Call-ID</th>
            <th style={th}>Source</th>
            <th style={th}>Dest</th>
            <th style={th}>Result</th>
            <th style={th}>Duration</th>
            <th style={th}>Messages</th>
            <th style={th}>Node</th>
          </tr>
        </thead>
        <tbody>
          {callGroups.map((group, idx) => {
            const row = group.representative;
            const grafanaHref = buildGrafanaLink(group, startTime, endTime);
            const isExpanded = expandedIdx === idx;

            return (
              <Fragment key={`${row.callid}-${idx}`}>
                <tr
                  onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                  style={tableRow(isExpanded)}
                  onMouseEnter={(e) => {
                    if (!isExpanded) e.currentTarget.style.background = hexToRgba(GLASS.accent, 0.06);
                  }}
                  onMouseLeave={(e) => {
                    if (!isExpanded) e.currentTarget.style.background = '';
                  }}
                  title="Click to expand SIP ladder"
                >
                  <td style={{ ...td, ...tdMono, whiteSpace: 'nowrap' }}>{fmtDateTime(row.timestamp)}</td>
                  <td style={td}>{displayUser(row.from_user)}</td>
                  <td style={td}>{displayUser(row.to_user)}</td>
                  <td
                    style={{ ...td, ...tdMono, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={group.callIds.join('\n')}
                  >
                    {row.callid}
                  </td>
                  <td style={{ ...td, ...tdMono }}>{row.src_ip}</td>
                  <td style={{ ...td, ...tdMono }}>{row.dst_ip}</td>
                  <td style={td}>
                    <StatusBadge status={group.finalStatus} />
                  </td>
                  <td style={td}>
                    <DurationBadge seconds={group.durationSec} />
                  </td>
                  <td style={td}>
                    <MsgCountBadge count={group.messages.length} />
                  </td>
                  <td style={{ ...td, ...tdMono, color: GLASS.textFaint }}>{row.node ?? '—'}</td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={10} style={{ padding: 0, border: 'none' }}>
                      <div style={{ padding: '0 8px 16px' }}>
                        {/* Secondary action: open in Grafana */}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 8px 0' }}>
                          <a
                            href={grafanaHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={grafanaLink()}
                          >
                            <IconExternal size={12} />
                            Open in Grafana
                          </a>
                        </div>
                        <SipLadder
                          messages={group.messages}
                          correlations={correlations}
                          pipelineWarnings={pipelineWarnings}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
