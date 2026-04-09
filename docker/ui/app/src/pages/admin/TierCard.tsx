import { cn } from '../../utils/cn';
import type { Tier, TierType } from '../../types/tier';

interface TierCardProps {
  tier: Tier;
  tierType: TierType;
  fullWidth?: boolean;
}

/** Convert snake_case/underscore keys to Title Case for display */
function toTitleCase(str: string): string {
  return str
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Strip the type prefix from a tier name (api_, trunk_) */
function displayName(name: string): string {
  return toTitleCase(name.replace(/^(api_|trunk_)/, ''));
}

interface FeatureShape {
  cps?: number;
  support?: string;
  features?: string[];
  [key: string]: unknown;
}

function parseFeatures(raw: unknown): { support?: string; items: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { items: [] };
  }

  const feat = raw as FeatureShape;
  const items: string[] = [];

  if (feat.support != null) {
    items.push(`Support: ${toTitleCase(String(feat.support))}`);
  }

  if (Array.isArray(feat.features)) {
    for (const f of feat.features) {
      items.push(toTitleCase(String(f)));
    }
  }

  const skip = new Set(['cps', 'support', 'features']);
  for (const [k, v] of Object.entries(feat)) {
    if (!skip.has(k)) {
      items.push(`${toTitleCase(k)}: ${String(v)}`);
    }
  }

  return { support: feat.support ? String(feat.support) : undefined, items };
}

// Max CPS ceilings used for the progress bar fill
const MAX_CPS: Record<string, number> = {
  trunk: 5,
  api: 15,
};

// Accent colors per tier type
const TIER_ACCENTS: Record<string, { color: string; bar: string }> = {
  trunk: { color: '#f59e0b', bar: '#f59e0b' },
  api_standard: { color: '#3b82f6', bar: '#3b82f6' },
  api_premium: { color: '#a855f7', bar: '#a855f7' },
  api_default: { color: '#8b5cf6', bar: '#8b5cf6' },
};

function getTierAccent(tierType: TierType, tierName: string): { color: string; bar: string } {
  if (tierType === 'trunk') return TIER_ACCENTS['trunk'];
  if (tierName.includes('standard')) return TIER_ACCENTS['api_standard'];
  if (tierName.includes('premium')) return TIER_ACCENTS['api_premium'];
  return TIER_ACCENTS['api_default'];
}

export function TierCard({ tier, tierType, fullWidth = false }: TierCardProps) {
  const maxCps = MAX_CPS[tierType] ?? 15;
  const fillPct = Math.min(100, Math.round((tier.cps_limit / maxCps) * 100));
  const isTrunkMaxed = tierType === 'trunk' && tier.cps_limit >= 5;
  const isApiStandard = tierType === 'api' && tier.name === 'api_standard';

  const { items: featureItems } = parseFeatures(tier.features);

  const perCallFee = parseFloat(String(tier.per_call_fee));
  const monthlyFeeLabel =
    tier.monthly_fee === 0 ? 'Free' : `$${Number(tier.monthly_fee).toFixed(2)}/mo`;

  const accent = getTierAccent(tierType, tier.name);

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: `1px solid ${isApiStandard ? 'rgba(59,130,246,0.35)' : 'rgba(42,47,69,0.6)'}`,
        borderRadius: 16,
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        boxShadow: isApiStandard
          ? '0 0 20px rgba(59,130,246,0.1), 0 4px 20px rgba(0,0,0,0.3)'
          : '0 4px 20px rgba(0,0,0,0.3)',
        transition: 'border-color 0.3s, box-shadow 0.3s',
        position: 'relative',
        overflow: 'hidden',
      }}
      className={cn(fullWidth && 'col-span-full')}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = `${accent.color}40`;
        (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 0 1px ${accent.color}20, 0 8px 30px rgba(0,0,0,0.4)`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = isApiStandard
          ? 'rgba(59,130,246,0.35)'
          : 'rgba(42,47,69,0.6)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = isApiStandard
          ? '0 0 20px rgba(59,130,246,0.1), 0 4px 20px rgba(0,0,0,0.3)'
          : '0 4px 20px rgba(0,0,0,0.3)';
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent.color}80, transparent)`,
          opacity: 0.5,
        }}
      />

      {/* Name */}
      <div>
        <div
          style={{
            fontSize: '1.05rem',
            fontWeight: 700,
            color: accent.color,
            letterSpacing: '-0.01em',
          }}
        >
          {displayName(tier.name)}
        </div>
        {tier.description && (
          <p style={{ fontSize: '0.78rem', color: '#718096', marginTop: 6, lineHeight: 1.5 }}>
            {tier.description}
          </p>
        )}
      </div>

      {/* CPS + progress bar */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 10 }}>
          <span
            style={{
              fontSize: '1.8rem',
              fontWeight: 800,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {tier.cps_limit}
          </span>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#718096' }}>CPS</span>
        </div>
        <div
          style={{
            height: 6,
            borderRadius: 4,
            background: 'rgba(42,47,69,0.8)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${fillPct}%`,
              borderRadius: 4,
              backgroundColor: accent.bar,
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      </div>

      {/* Pricing */}
      <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#e2e8f0' }}>
        {monthlyFeeLabel}
        {!isNaN(perCallFee) && perCallFee > 0 && (
          <span style={{ color: '#718096', fontWeight: 400, marginLeft: 6 }}>
            &middot; ${perCallFee.toFixed(4)}/call
          </span>
        )}
      </div>

      {/* Features */}
      {featureItems.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {featureItems.map((item) => (
            <li
              key={item}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: '0.8rem',
                color: '#a0aec0',
              }}
            >
              <span style={{ color: '#3b82f6', marginTop: 2, flexShrink: 0 }}>&#x2713;</span>
              {item}
            </li>
          ))}
        </ul>
      )}

      {/* Trunk upgrade note */}
      {isTrunkMaxed && (
        <p
          style={{
            fontSize: '0.73rem',
            color: '#718096',
            borderTop: '1px solid rgba(42,47,69,0.6)',
            paddingTop: 12,
            marginTop: 'auto',
          }}
        >
          Trunk CPS is fixed at 5. Purchase additional call paths for more concurrent capacity.
        </p>
      )}
    </div>
  );
}
