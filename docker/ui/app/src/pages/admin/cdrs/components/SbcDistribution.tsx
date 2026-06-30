/**
 * Live per-SBC call distribution panel — glassified. Polls `getSbcStats` every
 * 3s and renders a stacked bar + per-SBC rows. Degrades gracefully when the
 * endpoint is not yet deployed (404/503 are silenced).
 *
 * React #310: all hooks unconditionally at the top, before any early return.
 */

import { useQuery } from '@tanstack/react-query';
import { getSbcStats } from '../../../../api/sbc';
import type { SbcStat } from '../../../../api/sbc';
import { ApiError } from '../../../../api/client';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { MONO } from '../styles';

// ─── Colour palette ────────────────────────────────────────────────────────
const SBC_COLORS: Record<number, string> = {
  0: GLASS.accent,          // blue   — SBC-1
  1: GLASS.accentSecondary, // cyan   — SBC-2
  2: '#8b5cf6',             // purple — SBC-3+
};

function sbcColor(index: number): string {
  return SBC_COLORS[index] ?? '#8b5cf6';
}

// ─── Pulsing live indicator ─────────────────────────────────────────────────
const PULSE_STYLE_ID = 'sbc-pulse-keyframes';

function ensurePulseStyles(): void {
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
    @keyframes sbcPulse {
      0%   { opacity: 1; transform: scale(1);   }
      50%  { opacity: 0.4; transform: scale(1.5); }
      100% { opacity: 1; transform: scale(1);   }
    }
    .sbc-pulse-dot { animation: sbcPulse 3s ease-in-out infinite; }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sbcLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StackedBar({ sbcs }: { sbcs: SbcStat[] }) {
  if (sbcs.length === 0) {
    return <div style={{ height: 10, borderRadius: 6, background: 'rgba(255,255,255,0.06)' }} />;
  }
  return (
    <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
      {sbcs.map((sbc, i) => (
        <div
          key={sbc.sbc_id}
          title={`${sbcLabel(sbc.sbc_id)}: ${sbc.percentage.toFixed(1)}%`}
          style={{
            flex: sbc.percentage,
            background: sbcColor(i),
            borderRadius: i === 0 ? '6px 0 0 6px' : i === sbcs.length - 1 ? '0 6px 6px 0' : 0,
            minWidth: sbc.percentage > 0 ? 4 : 0,
            transition: 'flex 0.4s ease',
          }}
        />
      ))}
    </div>
  );
}

function SbcRow({ sbc, colorIndex }: { sbc: SbcStat; colorIndex: number }) {
  const color = sbcColor(colorIndex);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', alignItems: 'center', gap: 16 }}>
        {/* SBC name + colour dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, boxShadow: `0 0 6px ${hexToRgba(color, 0.6)}` }} />
          <span style={{ fontFamily: MONO, fontSize: '0.8125rem', fontWeight: 600, color: GLASS.text, letterSpacing: '-0.01em' }}>{sbcLabel(sbc.sbc_id)}</span>
        </div>

        {/* Calls last minute */}
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontFamily: MONO, fontSize: '1rem', fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{sbc.calls_last_minute}</span>
          <div style={{ fontSize: '0.6875rem', color: GLASS.textMuted, marginTop: 2 }}>last min</div>
        </div>

        {/* Calls in window */}
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontFamily: MONO, fontSize: '1rem', fontWeight: 700, color: GLASS.text, fontVariantNumeric: 'tabular-nums' }}>{sbc.calls_total}</span>
          <div style={{ fontSize: '0.6875rem', color: GLASS.textMuted, marginTop: 2 }}>window</div>
        </div>

        {/* Percentage */}
        <div style={{ textAlign: 'right', minWidth: 52 }}>
          <span style={{ fontFamily: MONO, fontSize: '1rem', fontWeight: 700, color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>{sbc.percentage.toFixed(1)}%</span>
          {sbc.answered_calls > 0 && (
            <div style={{ fontSize: '0.6875rem', color: GLASS.textMuted, marginTop: 2 }}>{fmtDurationMs(sbc.avg_duration_ms)} avg</div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${sbc.percentage}%`, background: `linear-gradient(90deg, ${hexToRgba(color, 0.8)}, ${color})`, borderRadius: 4, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SbcDistribution() {
  ensurePulseStyles();

  // ALL hooks unconditionally at top (React #310 discipline).
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ['sbc', 'stats'],
    queryFn: () => getSbcStats(5),
    refetchInterval: 3_000,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && (err.status === 404 || err.status === 503)) return false;
      return failureCount < 2;
    },
  });

  const lastUpdated =
    dataUpdatedAt > 0
      ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : null;

  return (
    <GlassPanel padding="20px 24px">
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="sbc-pulse-dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: GLASS.success, flexShrink: 0, boxShadow: `0 0 8px ${hexToRgba(GLASS.success, 0.7)}` }} />
          <h2 style={{ fontSize: '1rem', fontWeight: 700, color: GLASS.text, margin: 0, letterSpacing: '-0.01em' }}>SBC Call Distribution</h2>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {lastUpdated && <span style={{ fontSize: '0.75rem', color: GLASS.textMuted }}>{lastUpdated}</span>}
          {data && (
            <div style={{ textAlign: 'right' }}>
              <span style={{ fontFamily: MONO, fontSize: '1.5rem', fontWeight: 800, color: GLASS.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{data.total_calls}</span>
              <div style={{ fontSize: '0.6875rem', color: GLASS.textMuted, marginTop: 2 }}>calls / {data.window_minutes}min window</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Loading skeleton ── */}
      {isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2].map((n) => (
            <div key={n} style={{ height: 56, borderRadius: 10, background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.10) 37%, rgba(255,255,255,0.04) 63%)', backgroundSize: '200% 100%', animation: 'glass-shimmer 1.4s ease-in-out infinite' }} />
          ))}
        </div>
      )}

      {/* ── Error state ── */}
      {isError && !isLoading && (
        <div style={{ padding: '16px 20px', borderRadius: 12, background: hexToRgba(GLASS.danger, 0.12), border: `1px solid ${hexToRgba(GLASS.danger, 0.3)}`, color: '#fca5a5', fontSize: '0.8125rem' }}>
          <span style={{ fontWeight: 600 }}>SBC stats unavailable</span>
          {error instanceof Error && <span style={{ color: '#f87171', marginLeft: 8 }}>— {error.message}</span>}
          <div style={{ color: GLASS.textMuted, marginTop: 4, fontSize: '0.75rem' }}>The endpoint will become available once the backend is deployed.</div>
        </div>
      )}

      {/* ── Data view ── */}
      {data && !isLoading && (
        <>
          <div style={{ marginBottom: 20 }}>
            <StackedBar sbcs={data.sbcs} />
          </div>

          {data.total_calls === 0 && (
            <div style={{ padding: '20px 0', textAlign: 'center', color: GLASS.textMuted, fontSize: '0.875rem' }}>
              No calls in the last {data.window_minutes} minutes.{' '}
              <span style={{ color: GLASS.textFaint }}>Run a SIPp test to see distribution.</span>
            </div>
          )}

          {data.sbcs.length > 0 && (
            <div>
              {data.sbcs.map((sbc, i) => (
                <SbcRow key={sbc.sbc_id} sbc={sbc} colorIndex={i} />
              ))}
            </div>
          )}
        </>
      )}
    </GlassPanel>
  );
}
