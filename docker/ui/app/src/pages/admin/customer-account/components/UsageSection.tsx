/**
 * Usage & Analytics section: 30-day summary tiles, a pure-SVG daily call-volume
 * chart, and a recent-calls table — all on glass. Data + derivation come from
 * `useCustomerUsage`; this file is presentation only.
 */

import { useId } from 'react';
import { GLASS } from '../../../../components/glass/glass';
import { Spinner } from '../../../../components/ui/Spinner';
import type { Cdr } from '../../../../types/cdr';
import type { CdrSummaryRow } from '../../../../types/rate';
import { fmtDuration, useCustomerUsage } from '../hooks';
import type { UsageSummary } from '../types';
import { SectionPanel } from './SectionPanel';
import { StatTile } from './StatTiles';
import {
  chartShell,
  dirBadge,
  emptyNote,
  errorNote,
  inlineLoading,
  statusBadge,
  subLabel,
  tableHead,
  tableShell,
} from '../styles';

// ── Summary tiles ─────────────────────────────────────────────────────────────

function UsageSummaryCards({ summary, accent }: { summary: UsageSummary; accent: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <StatTile label="Total Calls (30d)" accent={accent} value={summary.totalCalls.toLocaleString()} />
      <StatTile
        label="Answered / ASR"
        accent={accent}
        value={
          <span>
            {summary.answeredCalls.toLocaleString()}{' '}
            <span style={{ fontSize: '0.78rem', color: GLASS.textMuted }}>({summary.asr}%)</span>
          </span>
        }
      />
      <StatTile label="Total Minutes" accent={accent} value={summary.totalMinutes.toLocaleString()} />
      <StatTile
        label="Avg Duration"
        accent={accent}
        value={summary.avgDurationSec > 0 ? fmtDuration(summary.avgDurationSec) : '—'}
      />
      <StatTile label="Total Cost" accent={accent} value={`$${summary.totalCost.toFixed(2)}`} />
    </div>
  );
}

// ── Daily volume chart (pure SVG, no library) ─────────────────────────────────

function DailyBarChart({ rows, accent }: { rows: CdrSummaryRow[]; accent: string }) {
  const gradientId = useId();

  const byDate = new Map<string, number>();
  for (const row of rows) {
    const dateKey = row.date ?? '';
    if (!dateKey) continue;
    byDate.set(dateKey, (byDate.get(dateKey) ?? 0) + row.total_calls);
  }

  const slots: Array<{ date: string; label: string; calls: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    slots.push({ date: key, label, calls: byDate.get(key) ?? 0 });
  }

  const maxCalls = Math.max(...slots.map((s) => s.calls), 1);

  const W = 900;
  const H = 200;
  const PAD_L = 40;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 32;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const points = slots.map((s, i) => ({
    x: PAD_L + (i / (slots.length - 1)) * chartW,
    y: PAD_T + chartH - (s.calls / maxCalls) * chartH,
  }));

  function smoothPath(pts: { x: number; y: number }[]): string {
    if (pts.length < 2) return '';
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const tension = 0.3;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  const linePath = smoothPath(points);
  const areaPath =
    linePath +
    ` L ${points[points.length - 1].x} ${PAD_T + chartH}` +
    ` L ${points[0].x} ${PAD_T + chartH} Z`;

  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const frac = i / gridCount;
    return { y: PAD_T + chartH - frac * chartH, value: Math.round(maxCalls * frac) };
  });

  const LABEL_EVERY = 5;

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', minHeight: 180, display: 'block' }}
        aria-label="Daily call volume chart"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.4} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.03} />
          </linearGradient>
        </defs>

        {gridLines.map(({ y, value }) => (
          <g key={value}>
            <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <text
              x={PAD_L - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={10}
              fill="#94a3b8"
              fontFamily="system-ui, -apple-system, sans-serif"
            >
              {value}
            </text>
          </g>
        ))}

        <path d={areaPath} fill={`url(#${gradientId})`} />

        <path
          d={linePath}
          fill="none"
          stroke={accent}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {points.map((p, i) => (
          <g key={slots[i].date}>
            <circle cx={p.x} cy={p.y} r={3} fill="#0f1117" stroke={accent} strokeWidth={1.5} />
            <title>
              {slots[i].label}: {slots[i].calls} calls
            </title>
          </g>
        ))}

        {slots.map((slot, i) => {
          if (i % LABEL_EVERY !== 0) return null;
          const x = PAD_L + (i / (slots.length - 1)) * chartW;
          return (
            <text
              key={slot.date}
              x={x}
              y={H - 8}
              textAnchor="middle"
              fontSize={10}
              fill="#94a3b8"
              fontFamily="system-ui, -apple-system, sans-serif"
            >
              {slot.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ── Recent calls table ────────────────────────────────────────────────────────

function RecentCallsTable({ cdrs }: { cdrs: Cdr[] }) {
  if (cdrs.length === 0) {
    return <div style={emptyNote}>No call records yet. CDRs will appear here after calls are processed.</div>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', color: '#cbd5e0' }}>
        <thead>
          <tr>
            {['Date / Time', 'Dir', 'From', 'To', 'Duration', 'Status', 'Hangup Cause'].map((h) => (
              <th key={h} style={tableHead}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cdrs.map((cdr, idx) => {
            const answered = cdr.answer_time != null;
            const startDt = new Date(cdr.start_time);
            const dateStr = startDt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const timeStr = startDt.toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            });

            return (
              <tr
                key={cdr.uuid}
                style={{
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                }}
              >
                <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                  <div style={{ color: '#a0aec0', fontVariantNumeric: 'tabular-nums' }}>{dateStr}</div>
                  <div style={{ color: GLASS.textMuted, fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' }}>
                    {timeStr}
                  </div>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={dirBadge(cdr.direction === 'inbound')}>
                    {cdr.direction === 'inbound' ? 'In' : 'Out'}
                  </span>
                </td>
                <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  {cdr.caller_id || '—'}
                </td>
                <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  {cdr.destination}
                </td>
                <td
                  style={{
                    padding: '8px 12px',
                    fontVariantNumeric: 'tabular-nums',
                    color: '#718096',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cdr.duration_seconds > 0 ? fmtDuration(cdr.duration_seconds) : '—'}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={statusBadge(answered)}>{answered ? 'Answered' : 'No Answer'}</span>
                </td>
                <td
                  style={{
                    padding: '8px 12px',
                    color: GLASS.textMuted,
                    fontFamily: 'monospace',
                    fontSize: '0.72rem',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cdr.hangup_cause ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export function UsageSection({ customerId, accent }: { customerId: number; accent: string }) {
  const { isLoading, isError, summaryRows, recentCdrs, computedSummary } = useCustomerUsage(customerId);

  return (
    <SectionPanel label="Usage & Analytics" accent={accent}>
      {isLoading && (
        <div style={inlineLoading}>
          <Spinner size="xs" /> Loading analytics…
        </div>
      )}

      {!isLoading && isError && (
        <div style={errorNote()}>Unable to load usage data. The CDR service may be unavailable.</div>
      )}

      {!isLoading && !isError && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <UsageSummaryCards summary={computedSummary} accent={accent} />

          <div>
            <div style={subLabel}>Daily Call Volume — Last 30 Days</div>
            <div style={chartShell}>
              {summaryRows.length === 0 ? (
                <div style={emptyNote}>
                  No call records yet. CDRs will appear here after calls are processed.
                </div>
              ) : (
                <DailyBarChart rows={summaryRows} accent={accent} />
              )}
            </div>
          </div>

          <div>
            <div style={subLabel}>Recent Calls</div>
            <div style={tableShell}>
              <RecentCallsTable cdrs={recentCdrs} />
            </div>
          </div>
        </div>
      )}
    </SectionPanel>
  );
}
