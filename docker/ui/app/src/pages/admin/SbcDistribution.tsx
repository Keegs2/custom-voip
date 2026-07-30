import { useQuery } from '@tanstack/react-query';
import { getSbcStats } from '../../api/sbc';
import type { SbcStat } from '../../api/sbc';
import { ApiError } from '../../api/client';

// ─── Colour palette ────────────────────────────────────────────────────────
// Each SBC slot maps to a distinct colour. SBC-3+ overflow uses purple.
const SBC_COLORS: Record<number, string> = {
  0: '#3b82f6', // blue        — SBC-1
  1: '#60a5fa', // light blue  — SBC-2
  2: '#93c5fd', // pale blue   — SBC-3+
};

function sbcColor(index: number): string {
  return SBC_COLORS[index] ?? '#93c5fd';
}

// ─── Pulsing live indicator ─────────────────────────────────────────────────
// A CSS keyframe animation injected once; the dot re-scales every 3 s to
// visually confirm the panel just refreshed.
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
    .sbc-pulse-dot {
      animation: sbcPulse 3s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Label shown in the UI — strips the raw sbc_id prefix noise if any. */
function sbcLabel(id: string): string {
  // Accept anything: "east-sbc-1", "sbc-1", "sbc1" — just display as-is but
  // upper-case the first letter for readability.
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

interface StackedBarProps {
  sbcs: SbcStat[];
}

function StackedBar({ sbcs }: StackedBarProps) {
  if (sbcs.length === 0) {
    return (
      <div
        style={{
          height: 10,
          borderRadius: 6,
          background: 'rgba(42,47,69,0.5)',
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        height: 10,
        borderRadius: 6,
        overflow: 'hidden',
        gap: 2,
      }}
    >
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

interface SbcRowProps {
  sbc: SbcStat;
  colorIndex: number;
}

function SbcRow({ sbc, colorIndex }: SbcRowProps) {
  const color = sbcColor(colorIndex);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '14px 0',
        borderBottom: '1px solid rgba(42,47,69,0.4)',
      }}
    >
      {/* Row header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto auto',
          alignItems: 'center',
          gap: 16,
        }}
      >
        {/* SBC name + colour dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: color,
              flexShrink: 0,
              boxShadow: `0 0 6px ${color}88`,
            }}
          />
          <span
            style={{
              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              fontSize: '0.8125rem',
              fontWeight: 600,
              color: '#e2e8f0',
              letterSpacing: '-0.01em',
            }}
          >
            {sbcLabel(sbc.sbc_id)}
          </span>
        </div>

        {/* Calls last minute */}
        <div style={{ textAlign: 'right' }}>
          <span
            style={{
              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              fontSize: '1rem',
              fontWeight: 700,
              color: color,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {sbc.calls_last_minute}
          </span>
          <div style={{ fontSize: '0.6875rem', color: '#475569', marginTop: 2 }}>
            last min
          </div>
        </div>

        {/* Calls in window */}
        <div style={{ textAlign: 'right' }}>
          <span
            style={{
              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              fontSize: '1rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {sbc.calls_total}
          </span>
          <div style={{ fontSize: '0.6875rem', color: '#475569', marginTop: 2 }}>
            window
          </div>
        </div>

        {/* Percentage */}
        <div style={{ textAlign: 'right', minWidth: 52 }}>
          <span
            style={{
              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              fontSize: '1rem',
              fontWeight: 700,
              color: '#94a3b8',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {sbc.percentage.toFixed(1)}%
          </span>
          {sbc.answered_calls > 0 && (
            <div style={{ fontSize: '0.6875rem', color: '#475569', marginTop: 2 }}>
              {fmtDurationMs(sbc.avg_duration_ms)} avg
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 4,
          borderRadius: 4,
          background: 'rgba(42,47,69,0.5)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${sbc.percentage}%`,
            background: `linear-gradient(90deg, ${color}cc, ${color})`,
            borderRadius: 4,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function SbcDistribution() {
  // Inject pulse animation once on first render — safe to call repeatedly
  ensurePulseStyles();

  // ALL hooks unconditionally at top (rules-of-hooks — this codebase has been
  // bitten by React #310 three times; never place hooks below early returns).
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ['sbc', 'stats'],
    queryFn: () => getSbcStats(5),
    refetchInterval: 3_000,
    // The endpoint may not exist until the backend is deployed — silence 404s
    // so the UI degrades gracefully rather than showing a noisy error.
    retry: (failureCount, err) => {
      if (err instanceof ApiError && (err.status === 404 || err.status === 503)) {
        return false;
      }
      return failureCount < 2;
    },
  });

  // Derive last-updated label from the React Query timestamp
  const lastUpdated =
    dataUpdatedAt > 0
      ? new Date(dataUpdatedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : null;

  // ─── Render ──────────────────────────────────────────────────────────────

  const cardStyle: React.CSSProperties = {
    borderRadius: 12,
    padding: '20px 24px',
  };

  return (
    <div className="glass-surface" style={cardStyle}>
      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Live pulse dot */}
          <span
            className="sbc-pulse-dot"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#22c55e',
              flexShrink: 0,
            }}
          />
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 700,
              color: '#e2e8f0',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            SBC Call Distribution
          </h2>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {lastUpdated && (
            <span style={{ fontSize: '0.75rem', color: '#475569' }}>
              {lastUpdated}
            </span>
          )}
          {data && (
            <div style={{ textAlign: 'right' }}>
              <span
                style={{
                  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                  fontSize: '1.5rem',
                  fontWeight: 800,
                  color: '#e2e8f0',
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1,
                }}
              >
                {data.total_calls}
              </span>
              <div style={{ fontSize: '0.6875rem', color: '#475569', marginTop: 2 }}>
                calls / {data.window_minutes}min window
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Loading skeleton ── */}
      {isLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1, 2].map((n) => (
            <div
              key={n}
              style={{
                height: 56,
                borderRadius: 8,
                background: 'rgba(42,47,69,0.3)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </div>
      )}

      {/* ── Error state ── */}
      {isError && !isLoading && (
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 8,
            background: 'rgba(127,29,29,0.25)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#fca5a5',
            fontSize: '0.8125rem',
          }}
        >
          <span style={{ fontWeight: 600 }}>SBC stats unavailable</span>
          {error instanceof Error && (
            <span style={{ color: '#f87171', marginLeft: 8 }}>
              — {error.message}
            </span>
          )}
          <div style={{ color: '#94a3b8', marginTop: 4, fontSize: '0.75rem' }}>
            The endpoint will become available once the backend is deployed.
          </div>
        </div>
      )}

      {/* ── Data view ── */}
      {data && !isLoading && (
        <>
          {/* Stacked distribution bar */}
          <div style={{ marginBottom: 20 }}>
            <StackedBar sbcs={data.sbcs} />
          </div>

          {/* Empty state */}
          {data.total_calls === 0 && (
            <div
              style={{
                padding: '20px 0',
                textAlign: 'center',
                color: '#475569',
                fontSize: '0.875rem',
              }}
            >
              No calls in the last {data.window_minutes} minutes.{' '}
              <span style={{ color: '#334155' }}>
                Run a SIPp test to see distribution.
              </span>
            </div>
          )}

          {/* Per-SBC rows */}
          {data.sbcs.length > 0 && (
            <div>
              {data.sbcs.map((sbc, i) => (
                <SbcRow key={sbc.sbc_id} sbc={sbc} colorIndex={i} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
