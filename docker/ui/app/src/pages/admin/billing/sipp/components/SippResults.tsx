/**
 * SippResults — the verdict + metrics readout for a finished (or in-flight)
 * SIPp run, rendered on a frosted-glass panel tinted by the run verdict.
 * Resilient to both the wire field names and the TS-type field names.
 */

import { Badge } from '../../../../../components/ui/Badge';
import { GlassPanel } from '../../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../../components/glass/glass';
import { cn } from '../../../../../utils/cn';
import type { SippRunResponse, SippVerdict } from '../../../../../types/sipp';
import { GlassTableWrap } from '../../components/GlassTableWrap';
import { th, td, statTile, statTileLabel, statTileValue, groupLabel } from '../../styles';

interface WireResults {
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

const VERDICT_ACCENT: Record<string, string> = {
  PASS: GLASS.success,
  WARN: GLASS.warning,
  FAIL: GLASS.danger,
};

function fmtNum(val: number | null | undefined): string {
  if (val == null) return '--';
  return String(val);
}

interface StatMiniProps {
  label: string;
  value: React.ReactNode;
  accent?: string;
}

function StatMini({ label, value, accent }: StatMiniProps) {
  return (
    <div style={statTile}>
      <p style={statTileLabel}>{label}</p>
      <p style={statTileValue(accent)}>{value}</p>
    </div>
  );
}

export function SippResults({ response, isRunning, runningTimeout = 60 }: SippResultsProps) {
  if (!response && !isRunning) {
    return null;
  }

  if (isRunning) {
    return (
      <GlassPanel padding="40px 32px">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              border: `3px solid ${hexToRgba(GLASS.accent, 0.22)}`,
              borderTopColor: GLASS.accent,
              animation: 'glass-spin 0.7s linear infinite',
            }}
          />
          <p style={{ color: GLASS.textMuted, fontSize: '0.88rem' }}>
            Test running — this may take up to {runningTimeout} seconds…
          </p>
        </div>
      </GlassPanel>
    );
  }

  if (!response) return null;

  const verdict = response.verdict ?? 'FAIL';
  const accent = VERDICT_ACCENT[verdict] ?? GLASS.danger;
  const r = response.results as WireResults;

  const totalCalls = r.total_calls ?? r.calls_attempted ?? null;
  const successful = r.successful ?? r.calls_completed ?? null;
  const failed = r.failed ?? r.calls_failed ?? null;
  const effectiveCps = r.effective_cps ?? null;
  const retransmissions = r.retransmissions ?? null;
  const elapsedSeconds = r.elapsed_seconds ?? null;
  const failedColor = (failed ?? 0) > 0 ? GLASS.danger : GLASS.textMuted;

  return (
    <GlassPanel padding={0} accent={accent}>
      {/* Header: verdict + config summary */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 12,
          padding: '16px 24px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <Badge variant={verdictBadgeVariant(verdict)}>{verdict}</Badge>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: '0.82rem', color: GLASS.textMuted }}>
          <span>Target: <strong style={{ color: GLASS.text }}>{response.config?.remote_host ?? '--'}</strong></span>
          <span>Rate: <strong style={{ color: GLASS.text }}>{response.config?.call_rate ?? '--'} CPS</strong></span>
          <span>Calls: <strong style={{ color: GLASS.text }}>{response.config?.call_limit ?? '--'}</strong></span>
        </div>
      </div>

      <div style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* Key Metrics */}
        <div>
          <p style={groupLabel}>Key Metrics</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatMini label="Total Calls" value={fmtNum(totalCalls)} />
            <StatMini label="Successful" value={fmtNum(successful)} accent={GLASS.success} />
            <StatMini label="Failed" value={fmtNum(failed)} accent={failedColor} />
            <StatMini label="Effective CPS" value={effectiveCps != null ? Number(effectiveCps).toFixed(1) : '--'} />
            <StatMini label="Retransmissions" value={fmtNum(retransmissions)} accent={(retransmissions ?? 0) > 0 ? GLASS.warning : undefined} />
            <StatMini label="Elapsed Time" value={elapsedSeconds != null ? `${Number(elapsedSeconds).toFixed(2)}s` : '--'} />
          </div>
        </div>

        {/* SIP Message Breakdown */}
        <div>
          <p style={groupLabel}>SIP Message Breakdown</p>
          <GlassTableWrap>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
                <th style={th}>Message</th>
                <th style={{ ...th, textAlign: 'right' }}>Count</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={td}>INVITE Sent</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.invite_sent)}</td>
              </tr>
              <tr>
                <td style={td}>100 Trying</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.response_100)}</td>
              </tr>
              <tr>
                <td style={td}>200 OK</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} className="text-green-400">{fmtNum(r.response_200)}</td>
              </tr>
              <tr>
                <td style={td}>Timeouts</td>
                <td
                  style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  className={cn((r.timeouts ?? 0) > 0 ? 'text-red-400' : 'text-[#94a3b8]')}
                >
                  {fmtNum(r.timeouts)}
                </td>
              </tr>
              <tr>
                <td style={td}>Unexpected Messages</td>
                <td
                  style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  className={cn((r.unexpected_msg ?? 0) > 0 ? 'text-amber-300' : 'text-[#94a3b8]')}
                >
                  {fmtNum(r.unexpected_msg)}
                </td>
              </tr>
            </tbody>
          </GlassTableWrap>
        </div>
      </div>
    </GlassPanel>
  );
}
