import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCdrSummary } from '../../api/cdrs';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { TableWrap, Table, Thead, Th, Td } from '../../components/ui/Table';
import type { ProductType, CallDirection } from '../../types/cdr';
import type { CdrSummaryRow } from '../../types/rate';

type GroupBy = 'day' | 'hour' | 'destination';

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

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cdr-summary', { customerId, groupBy }],
    queryFn: () =>
      getCdrSummary({
        customer_id: customerId ? Number(customerId) : undefined,
        group_by: groupBy,
      }),
  });

  const dateColLabel =
    groupBy === 'hour' ? 'Hour' : groupBy === 'destination' ? 'Destination' : 'Date';

  return (
    <div>
      {/* Group by selector */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[0.7rem] font-bold uppercase tracking-[0.7px] text-[#718096]">
          Group by
        </span>
        {(['day', 'hour', 'destination'] as GroupBy[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroupBy(g)}
            className={[
              'px-3 py-1 text-[0.78rem] font-semibold rounded-md border transition-colors duration-150',
              groupBy === g
                ? 'bg-[#3b82f6]/[0.12] text-[#3b82f6] border-[#3b82f6]/30'
                : 'bg-transparent text-[#718096] border-[#2a2f45] hover:text-[#e2e8f0] hover:border-[#3d4460]',
            ].join(' ')}
          >
            {g.charAt(0).toUpperCase() + g.slice(1)}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] py-8">
          <Spinner /> Loading summary…
        </div>
      )}

      {isError && (
        <p className="text-red-400 text-sm py-4">Failed to load summary data.</p>
      )}

      {data && data.summary.length === 0 && (
        <div className="text-center py-10 text-[#718096] text-sm">
          <p className="font-semibold text-[#e2e8f0] mb-1">No summary data</p>
          <p>Run a search first, then switch to this tab.</p>
        </div>
      )}

      {data && data.summary.length > 0 && (
        <TableWrap>
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
                const asr =
                  row.total_calls > 0
                    ? (row.answered_calls / row.total_calls) * 100
                    : 0;

                return (
                  <tr key={i} className="hover:bg-white/[0.015] transition-colors">
                    <Td>
                      <span className="font-mono text-[0.82rem] text-[#e2e8f0] whitespace-nowrap">
                        {groupLabel(row, groupBy)}
                      </span>
                    </Td>
                    <Td>
                      {row.product_type ? (
                        <Badge variant={row.product_type as ProductType}>
                          {row.product_type.toUpperCase()}
                        </Badge>
                      ) : (
                        <span className="text-[#718096]">--</span>
                      )}
                    </Td>
                    <Td>
                      {row.direction ? (
                        <Badge variant={row.direction as CallDirection}>
                          {row.direction}
                        </Badge>
                      ) : (
                        <span className="text-[#718096]">--</span>
                      )}
                    </Td>
                    <Td>
                      <span className="tabular-nums text-[#e2e8f0]">
                        {row.total_calls.toLocaleString()}
                      </span>
                    </Td>
                    <Td>
                      <span className="tabular-nums text-[#e2e8f0]">
                        {row.answered_calls.toLocaleString()}
                      </span>
                    </Td>
                    <Td>
                      <span className={`tabular-nums text-[0.82rem] ${asrColor(asr)}`}>
                        {asr.toFixed(1)}%
                      </span>
                    </Td>
                    <Td>
                      <span className="tabular-nums text-[#e2e8f0]">
                        {formatTotalDuration(row.total_duration_sec)}
                      </span>
                    </Td>
                    <Td>
                      <span className="tabular-nums text-[0.82rem] text-green-400">
                        ${row.total_cost.toFixed(4)}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
