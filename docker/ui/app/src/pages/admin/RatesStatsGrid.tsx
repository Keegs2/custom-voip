import type { MarginsData } from '../../types/rate';

interface LocalStatCardProps {
  label: string;
  value: React.ReactNode;
  icon: string;
  accent?: string;
}

function LocalStatCard({ label, value, icon, accent }: LocalStatCardProps) {
  return (
    <div
      style={{
        position: 'relative',
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '20px 24px',
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(42,47,69,0.9)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 6px 24px rgba(0,0,0,0.4)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(42,47,69,0.6)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)';
      }}
    >
      {/* Background icon */}
      <span
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          fontSize: '1.5rem',
          opacity: 0.1,
          lineHeight: 1,
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      >
        {icon}
      </span>

      <p
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 10,
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontSize: '1.9rem',
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

interface RatesStatsGridProps {
  margins: MarginsData;
}

export function RatesStatsGrid({ margins }: RatesStatsGridProps) {
  const avgPct = margins.avg_margin_pct;
  const negCount = margins.negative_margins?.length ?? margins.negative_margin_count ?? 0;
  const lowCount = margins.low_margins?.length ?? 0;

  const avgAccent =
    avgPct > 30 ? '#4ade80' : avgPct >= 15 ? '#fbbf24' : '#f87171';

  return (
    <div style={{ marginBottom: 24 }}>
      {negCount > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            background: 'rgba(239,68,68,0.07)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 12,
            color: '#f87171',
            fontSize: '0.875rem',
            fontWeight: 500,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: '1rem', flexShrink: 0 }}>&#x26A0;</span>
          <span>
            <strong style={{ fontWeight: 700 }}>
              {negCount} rate{negCount === 1 ? '' : 's'}
            </strong>{' '}
            have negative margins — you are losing money on these destinations.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <LocalStatCard label="Total Rates" value={margins.total_rates} icon="$" />
        <LocalStatCard
          label="Avg Margin %"
          value={`${avgPct.toFixed(1)}%`}
          icon="%"
          accent={avgAccent}
        />
        <LocalStatCard
          label="Negative Margins"
          value={negCount}
          icon="!"
          accent={negCount > 0 ? '#f87171' : undefined}
        />
        <LocalStatCard
          label="Low Margins"
          value={lowCount}
          icon="~"
          accent={lowCount > 0 ? '#fbbf24' : undefined}
        />
      </div>
    </div>
  );
}
