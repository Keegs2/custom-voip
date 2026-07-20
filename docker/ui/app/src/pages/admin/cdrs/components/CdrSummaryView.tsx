/**
 * CDR summary tab — grouped aggregates (day / hour / destination). Glassified
 * group-by toggle + frosted table. Query lives in `useCdrSummary`.
 */

import { useState } from 'react';
import { Badge } from '../../../../components/ui/Badge';
import { Table, Thead, Th, Td } from '../../../../components/ui/Table';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { useCdrSummary } from '../hooks';
import { groupBtn } from '../styles';
import { LoadingRow, StateCard } from './states';
import { IconEmpty, IconError } from './icons';
import type { GroupBy } from '../types';
import type { ProductType, CallDirection } from '../../../../types/cdr';
import type { CdrSummaryRow } from '../../../../types/rate';

function formatTotalDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function asrColor(asr: number): string {
  if (asr > 50) return 'text-green-400';
  if (asr >= 30) return 'text-amber-400';
  return 'text-red-400';
}

function groupLabel(row: CdrSummaryRow, groupBy: GroupBy): string {
  if (groupBy === 'hour') return row.hour ?? '--';
  if (groupBy === 'destination') return row.destination ?? '--';
  return row.date ?? '--';
}

interface CdrSummaryViewProps {
  customerId?: string;
}

export function CdrSummaryView({ customerId }: CdrSummaryViewProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const { data, isLoading, isError } = useCdrSummary(customerId, groupBy);

  const dateColLabel = groupBy === 'hour' ? 'Hour' : groupBy === 'destination' ? 'Destination' : 'Date';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Group by selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="text-[0.7rem] font-bold uppercase tracking-[0.1em] text-[#94a3b8]">Group by</span>
        {(['day', 'hour', 'destination'] as GroupBy[]).map((g) => (
          <button key={g} type="button" onClick={() => setGroupBy(g)} style={groupBtn(groupBy === g)}>
            {g.charAt(0).toUpperCase() + g.slice(1)}
          </button>
        ))}
      </div>

      {isLoading && <LoadingRow label="Loading summary…" />}

      {isError && (
        <StateCard accent={GLASS.danger} icon={<IconError />} title="Failed to load summary" body="The summary request failed. Adjust your filters and try again." />
      )}

      {data && data.summary.length === 0 && (
        <StateCard icon={<IconEmpty />} title="No summary data" body="Run a search first, then switch to this tab." />
      )}

      {data && data.summary.length > 0 && (
        <GlassPanel padding={0}>
          <div style={{ overflowX: 'auto', borderRadius: 20 }}>
            <Table>
              <Thead>
                <tr>
                  <Th>{dateColLabel}</Th>
                  <Th>Product</Th>
                  <Th>Direction</Th>
                  <Th>Total Calls</Th>
                  <Th>Answered</Th>
                  <Th>ASR</Th>
                  <Th>Duration</Th>
                  <Th>Total Cost</Th>
                </tr>
              </Thead>
              <tbody>
                {data.summary.map((row, i) => {
                  const asr = row.total_calls > 0 ? (row.answered_calls / row.total_calls) * 100 : 0;
                  return (
                    <tr key={i} className="hover:bg-white/[0.03] transition-colors">
                      <Td>
                        <span className="font-mono text-[0.82rem] text-[#e2e8f0] whitespace-nowrap">{groupLabel(row, groupBy)}</span>
                      </Td>
                      <Td>
                        {row.product_type ? <Badge variant={row.product_type as ProductType}>{row.product_type.toUpperCase()}</Badge> : <span className="text-[#94a3b8]">--</span>}
                      </Td>
                      <Td>
                        {row.direction ? <Badge variant={row.direction as CallDirection}>{row.direction}</Badge> : <span className="text-[#94a3b8]">--</span>}
                      </Td>
                      <Td><span className="tabular-nums text-[#e2e8f0]">{row.total_calls.toLocaleString()}</span></Td>
                      <Td><span className="tabular-nums text-[#e2e8f0]">{row.answered_calls.toLocaleString()}</span></Td>
                      <Td><span className={`tabular-nums text-[0.82rem] ${asrColor(asr)}`}>{asr.toFixed(1)}%</span></Td>
                      <Td><span className="tabular-nums text-[#e2e8f0]">{formatTotalDuration(row.total_duration_sec)}</span></Td>
                      <Td><span className="tabular-nums text-[0.82rem] text-green-400">${row.total_cost.toFixed(4)}</span></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        </GlassPanel>
      )}
    </div>
  );
}
