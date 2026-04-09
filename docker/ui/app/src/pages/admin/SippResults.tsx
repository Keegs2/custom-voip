import { cn } from '../../utils/cn';
import { Badge } from '../../components/ui/Badge';
import { TableWrap, Table, Thead, Th, Td } from '../../components/ui/Table';
import { Spinner } from '../../components/ui/Spinner';
import type { SippRunResponse, SippVerdict } from '../../types/sipp';

/**
 * The wire response uses different field names from the TypeScript type.
 * We handle both shapes here to be resilient against API variations.
 */
interface WireResults {
  // Legacy / actual API field names
  total_calls?: number | null;
  successful?: number | null;
  failed?: number | null;
  effective_cps?: number | null;
  retransmissions?: number | null;
  elapsed_seconds?: number | null;
  invite_sent?: number | null;
  response_100?: number | null;
  response_200?: number | null;
  timeouts?: number | null;
  unexpected_msg?: number | null;
  // TypeScript type field names
  calls_attempted?: number | null;
  calls_completed?: number | null;
  calls_failed?: number | null;
  avg_response_ms?: number | null;
  raw_output?: string | null;
}

interface SippResultsProps {
  response: SippRunResponse | null;
  isRunning: boolean;
  runningTimeout?: number;
}

function verdictBadgeVariant(verdict: SippVerdict) {
  if (verdict === 'PASS') return 'pass';
  if (verdict === 'WARN') return 'warn';
  return 'fail';
}

function fmtNum(val: number | null | undefined): string {
  if (val == null) return '--';
  return String(val);
}

export function SippResults({ response, isRunning, runningTimeout = 60 }: SippResultsProps) {
  if (!response && !isRunning) {
    return null;
  }

  if (isRunning) {
    return (
      <div
        className={cn(
          'rounded-xl border border-blue-500/30 bg-[#1a1d27] p-10 text-center',
          'shadow-[0_0_24px_rgba(59,130,246,0.12)]',
        )}
        style={{
          animation: 'sipp-pulse 1.8s ease-in-out infinite',
        }}
      >
        <style>{`
          @keyframes sipp-pulse {
            0%, 100% { box-shadow: 0 0 16px rgba(59,130,246,0.12); }
            50%       { box-shadow: 0 0 40px rgba(59,130,246,0.35); }
          }
        `}</style>
        <Spinner size="lg" className="text-blue-400 mx-auto mb-4" />
        <p className="text-[#718096] text-[0.88rem]">
          Test running — this may take up to {runningTimeout} seconds…
        </p>
      </div>
    );
  }

  if (!response) return null;

  const verdict = response.verdict ?? 'FAIL';
  // Merge both possible result shapes
  const r = response.results as WireResults;

  const totalCalls = r.total_calls ?? r.calls_attempted ?? null;
  const successful = r.successful ?? r.calls_completed ?? null;
  const failed = r.failed ?? r.calls_failed ?? null;
  const effectiveCps = r.effective_cps ?? null;
  const retransmissions = r.retransmissions ?? null;
  const elapsedSeconds = r.elapsed_seconds ?? null;

  const failedColor =
    (failed ?? 0) > 0 ? 'text-red-400' : 'text-[#718096]';

  return (
    <div
      className={cn(
        'rounded-xl border bg-[#1a1d27]',
        verdict === 'PASS'
          ? 'border-green-500/30 shadow-[0_0_20px_rgba(74,222,128,0.08)]'
          : verdict === 'WARN'
            ? 'border-amber-500/30 shadow-[0_0_20px_rgba(245,158,11,0.08)]'
            : 'border-red-500/30 shadow-[0_0_20px_rgba(239,68,68,0.08)]',
      )}
    >
      {/* Header: verdict + config summary */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-[#2a2f45]">
        <Badge variant={verdictBadgeVariant(verdict)}>{verdict}</Badge>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.82rem] text-[#718096]">
          <span>
            Target:{' '}
            <strong className="text-[#e2e8f0]">
              {response.config?.remote_host ?? '--'}
            </strong>
          </span>
          <span>
            Rate:{' '}
            <strong className="text-[#e2e8f0]">
              {response.config?.call_rate ?? '--'} CPS
            </strong>
          </span>
          <span>
            Calls:{' '}
            <strong className="text-[#e2e8f0]">
              {response.config?.call_limit ?? '--'}
            </strong>
          </span>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Key Metrics — 6 stat cards */}
        <div>
          <p className="text-[0.65rem] font-bold text-[#4a5568] uppercase tracking-[0.8px] mb-3">
            Key Metrics
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatMini label="Total Calls" value={fmtNum(totalCalls)} />
            <StatMini
              label="Successful"
              value={fmtNum(successful)}
              valueClass="text-green-400"
            />
            <StatMini
              label="Failed"
              value={fmtNum(failed)}
              valueClass={failedColor}
            />
            <StatMini
              label="Effective CPS"
              value={effectiveCps != null ? Number(effectiveCps).toFixed(1) : '--'}
            />
            <StatMini
              label="Retransmissions"
              value={fmtNum(retransmissions)}
              valueClass={(retransmissions ?? 0) > 0 ? 'text-amber-300' : undefined}
            />
            <StatMini
              label="Elapsed Time"
              value={
                elapsedSeconds != null
                  ? `${Number(elapsedSeconds).toFixed(2)}s`
                  : '--'
              }
            />
          </div>
        </div>

        {/* SIP Message Breakdown */}
        <div>
          <p className="text-[0.65rem] font-bold text-[#4a5568] uppercase tracking-[0.8px] mb-3">
            SIP Message Breakdown
          </p>
          <TableWrap>
            <Table>
              <Thead>
                <tr>
                  <Th>Message</Th>
                  <Th className="text-right">Count</Th>
                </tr>
              </Thead>
              <tbody>
                <tr>
                  <Td>INVITE Sent</Td>
                  <Td className="text-right tabular-nums">{fmtNum(r.invite_sent)}</Td>
                </tr>
                <tr>
                  <Td>100 Trying</Td>
                  <Td className="text-right tabular-nums">{fmtNum(r.response_100)}</Td>
                </tr>
                <tr>
                  <Td>200 OK</Td>
                  <Td className="text-right tabular-nums text-green-400">
                    {fmtNum(r.response_200)}
                  </Td>
                </tr>
                <tr>
                  <Td>Timeouts</Td>
                  <Td
                    className={cn(
                      'text-right tabular-nums',
                      (r.timeouts ?? 0) > 0 ? 'text-red-400' : 'text-[#718096]',
                    )}
                  >
                    {fmtNum(r.timeouts)}
                  </Td>
                </tr>
                <tr>
                  <Td>Unexpected Messages</Td>
                  <Td
                    className={cn(
                      'text-right tabular-nums',
                      (r.unexpected_msg ?? 0) > 0 ? 'text-amber-300' : 'text-[#718096]',
                    )}
                  >
                    {fmtNum(r.unexpected_msg)}
                  </Td>
                </tr>
              </tbody>
            </Table>
          </TableWrap>
        </div>
      </div>
    </div>
  );
}

interface StatMiniProps {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}

function StatMini({ label, value, valueClass }: StatMiniProps) {
  return (
    <div className="bg-[#1e2130] border border-[#2a2f45] rounded-lg p-3">
      <p className="text-[0.62rem] font-bold text-[#4a5568] uppercase tracking-[0.8px] mb-1.5">
        {label}
      </p>
      <p className={cn('text-xl font-extrabold tabular-nums leading-none text-[#e2e8f0]', valueClass)}>
        {value}
      </p>
    </div>
  );
}
