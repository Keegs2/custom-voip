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

const VERDICT_STYLES: Record<string, { border: string; glow: string }> = {
  PASS: { border: 'rgba(74,222,128,0.3)', glow: 'rgba(74,222,128,0.08)' },
  WARN: { border: 'rgba(245,158,11,0.3)', glow: 'rgba(245,158,11,0.08)' },
  FAIL: { border: 'rgba(239,68,68,0.3)', glow: 'rgba(239,68,68,0.08)' },
};

export function SippResults({ response, isRunning, runningTimeout = 60 }: SippResultsProps) {
  if (!response && !isRunning) {
    return null;
  }

  if (isRunning) {
    return (
      <div
        style={{
          borderRadius: 16,
          border: '1px solid rgba(59,130,246,0.3)',
          background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
          padding: '40px',
          textAlign: 'center',
          boxShadow: '0 0 24px rgba(59,130,246,0.12)',
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
        <p style={{ color: '#718096', fontSize: '0.88rem' }}>
          Test running — this may take up to {runningTimeout} seconds…
        </p>
      </div>
    );
  }

  if (!response) return null;

  const verdict = response.verdict ?? 'FAIL';
  const verdictStyle = VERDICT_STYLES[verdict] ?? VERDICT_STYLES['FAIL'];
  // Merge both possible result shapes
  const r = response.results as WireResults;

  const totalCalls = r.total_calls ?? r.calls_attempted ?? null;
  const successful = r.successful ?? r.calls_completed ?? null;
  const failed = r.failed ?? r.calls_failed ?? null;
  const effectiveCps = r.effective_cps ?? null;
  const retransmissions = r.retransmissions ?? null;
  const elapsedSeconds = r.elapsed_seconds ?? null;

  const failedColor =
    (failed ?? 0) > 0 ? '#f87171' : '#718096';

  return (
    <div
      style={{
        borderRadius: 16,
        border: `1px solid ${verdictStyle.border}`,
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        boxShadow: `0 0 20px ${verdictStyle.glow}, 0 4px 20px rgba(0,0,0,0.3)`,
        overflow: 'hidden',
      }}
    >
      {/* Header: verdict + config summary */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 12,
          padding: '16px 24px',
          borderBottom: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <Badge variant={verdictBadgeVariant(verdict)}>{verdict}</Badge>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px 16px',
            fontSize: '0.82rem',
            color: '#718096',
          }}
        >
          <span>
            Target:{' '}
            <strong style={{ color: '#e2e8f0' }}>
              {response.config?.remote_host ?? '--'}
            </strong>
          </span>
          <span>
            Rate:{' '}
            <strong style={{ color: '#e2e8f0' }}>
              {response.config?.call_rate ?? '--'} CPS
            </strong>
          </span>
          <span>
            Calls:{' '}
            <strong style={{ color: '#e2e8f0' }}>
              {response.config?.call_limit ?? '--'}
            </strong>
          </span>
        </div>
      </div>

      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Key Metrics — 6 stat cards */}
        <div>
          <p
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              color: '#4a5568',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 12,
            }}
          >
            Key Metrics
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatMini label="Total Calls" value={fmtNum(totalCalls)} />
            <StatMini
              label="Successful"
              value={fmtNum(successful)}
              accent="#4ade80"
            />
            <StatMini
              label="Failed"
              value={fmtNum(failed)}
              accent={failedColor}
            />
            <StatMini
              label="Effective CPS"
              value={effectiveCps != null ? Number(effectiveCps).toFixed(1) : '--'}
            />
            <StatMini
              label="Retransmissions"
              value={fmtNum(retransmissions)}
              accent={(retransmissions ?? 0) > 0 ? '#fcd34d' : undefined}
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
          <p
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              color: '#4a5568',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 12,
            }}
          >
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
  accent?: string;
}

function StatMini({ label, value, accent }: StatMiniProps) {
  return (
    <div
      style={{
        background: 'rgba(19,21,29,0.8)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 10,
        padding: '12px',
      }}
    >
      <p
        style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 8,
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontSize: '1.25rem',
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          color: accent ?? '#e2e8f0',
        }}
      >
        {value}
      </p>
    </div>
  );
}
