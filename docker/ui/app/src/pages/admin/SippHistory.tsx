import { Badge } from '../../components/ui/Badge';
import { TableWrap, Table, Thead, Th, Td } from '../../components/ui/Table';
import type { SippRunResponse, SippVerdict } from '../../types/sipp';

interface HistoryEntry extends SippRunResponse {
  _timestamp: number;
  _presetName?: string;
}

interface WireResults {
  total_calls?: number | null;
  successful?: number | null;
  calls_attempted?: number | null;
  calls_completed?: number | null;
  effective_cps?: number | null;
}

interface SippHistoryProps {
  history: HistoryEntry[];
}

function verdictVariant(verdict: SippVerdict) {
  if (verdict === 'PASS') return 'pass';
  if (verdict === 'WARN') return 'warn';
  return 'fail';
}

export function SippHistory({ history }: SippHistoryProps) {
  if (history.length === 0) return null;

  return (
    <div>
      <p className="text-[0.65rem] font-bold text-[#4a5568] uppercase tracking-[0.8px] mb-3">
        Test History (last 5)
      </p>
      <TableWrap>
        <Table>
          <Thead>
            <tr>
              <Th>Time</Th>
              <Th>Preset</Th>
              <Th>Rate</Th>
              <Th>Calls</Th>
              <Th>Success %</Th>
              <Th>CPS</Th>
              <Th>Verdict</Th>
            </tr>
          </Thead>
          <tbody>
            {history.map((entry) => {
              const r = entry.results as WireResults;
              const cfg = entry.config;
              const totalCalls = r.total_calls ?? r.calls_attempted ?? 0;
              const successful = r.successful ?? r.calls_completed ?? 0;
              const successPct =
                totalCalls > 0
                  ? `${((successful / totalCalls) * 100).toFixed(1)}%`
                  : '--';
              const effectiveCps = r.effective_cps;
              const ts = new Date(entry._timestamp).toLocaleTimeString();
              const presetLabel = entry._presetName ?? 'Custom';

              return (
                <tr
                  key={entry._timestamp}
                  className="hover:bg-white/[0.02] transition-colors"
                >
                  <Td className="text-[#718096] text-[0.78rem] whitespace-nowrap">
                    {ts}
                  </Td>
                  <Td>{presetLabel}</Td>
                  <Td className="tabular-nums">{cfg?.call_rate ?? '--'}</Td>
                  <Td className="tabular-nums">{cfg?.call_limit ?? '--'}</Td>
                  <Td className="tabular-nums">{successPct}</Td>
                  <Td className="tabular-nums">
                    {effectiveCps != null
                      ? Number(effectiveCps).toFixed(1)
                      : '--'}
                  </Td>
                  <Td>
                    <Badge variant={verdictVariant(entry.verdict)}>
                      {entry.verdict}
                    </Badge>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </TableWrap>
    </div>
  );
}

export type { HistoryEntry };
