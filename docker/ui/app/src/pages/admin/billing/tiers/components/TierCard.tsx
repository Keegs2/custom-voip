/**
 * TierCard — one service tier rendered as an interactive frosted-glass card.
 * Uses the canonical <GlassCard> (hover lift + accent glow + staggered entrance)
 * with a per-tier semantic accent (trunk amber, API blue/purple). Presentation
 * only.
 */

import { GlassCard } from '../../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../../components/glass/glass';
import { cn } from '../../../../../utils/cn';
import type { Tier, TierType } from '../../../../../types/tier';

interface TierCardProps {
  tier: Tier;
  tierType: TierType;
  fullWidth?: boolean;
  index?: number;
}

function toTitleCase(str: string): string {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function displayName(name: string): string {
  return toTitleCase(name.replace(/^(api_|trunk_)/, ''));
}

interface FeatureShape {
  cps?: number;
  support?: string;
  features?: string[];
  [key: string]: unknown;
}

function parseFeatures(raw: unknown): { items: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { items: [] };
  const feat = raw as FeatureShape;
  const items: string[] = [];
  if (feat.support != null) items.push(`Support: ${toTitleCase(String(feat.support))}`);
  if (Array.isArray(feat.features)) for (const f of feat.features) items.push(toTitleCase(String(f)));
  const skip = new Set(['cps', 'support', 'features']);
  for (const [k, v] of Object.entries(feat)) {
    if (!skip.has(k)) items.push(`${toTitleCase(k)}: ${String(v)}`);
  }
  return { items };
}

const MAX_CPS: Record<string, number> = { trunk: 5, api: 15 };

function getTierAccent(tierType: TierType, tierName: string): string {
  if (tierType === 'trunk') return GLASS.warning;       // amber
  if (tierName.includes('standard')) return GLASS.accent; // blue
  if (tierName.includes('premium')) return '#a855f7';     // purple
  return '#8b5cf6';                                       // violet
}

export function TierCard({ tier, tierType, fullWidth = false, index = 0 }: TierCardProps) {
  const maxCps = MAX_CPS[tierType] ?? 15;
  const fillPct = Math.min(100, Math.round((tier.cps_limit / maxCps) * 100));
  const isTrunkMaxed = tierType === 'trunk' && tier.cps_limit >= 5;

  const { items: featureItems } = parseFeatures(tier.features);
  const perCallFee = parseFloat(String(tier.per_call_fee));
  const monthlyFeeLabel = tier.monthly_fee === 0 ? 'Free' : `$${Number(tier.monthly_fee).toFixed(2)}/mo`;
  const accent = getTierAccent(tierType, tier.name);

  return (
    <GlassCard
      index={index}
      accent={accent}
      style={fullWidth ? { gridColumn: '1 / -1' } : undefined}
    >
      <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 20 }} className={cn(fullWidth && 'col-span-full')}>
        {/* Name */}
        <div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: accent, letterSpacing: '-0.01em', textShadow: `0 0 16px ${hexToRgba(accent, 0.3)}` }}>
            {displayName(tier.name)}
          </div>
          {tier.description && (
            <p style={{ fontSize: '0.78rem', color: GLASS.textMuted, marginTop: 6, lineHeight: 1.5 }}>{tier.description}</p>
          )}
        </div>

        {/* CPS + progress bar */}
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 10 }}>
            <span style={{ fontSize: '1.8rem', fontWeight: 800, color: GLASS.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1, textShadow: '0 1px 12px rgba(0,0,0,0.5)' }}>
              {tier.cps_limit}
            </span>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: GLASS.textMuted }}>CPS</span>
          </div>
          <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${fillPct}%`,
                borderRadius: 4,
                background: `linear-gradient(90deg, ${hexToRgba(accent, 0.8)}, ${accent})`,
                boxShadow: `0 0 10px ${hexToRgba(accent, 0.5)}`,
                transition: 'width 0.5s ease',
              }}
            />
          </div>
        </div>

        {/* Pricing */}
        <div style={{ fontSize: '0.9rem', fontWeight: 600, color: GLASS.text }}>
          {monthlyFeeLabel}
          {!isNaN(perCallFee) && perCallFee > 0 && (
            <span style={{ color: GLASS.textMuted, fontWeight: 400, marginLeft: 6 }}>
              &middot; ${perCallFee.toFixed(4)}/call
            </span>
          )}
        </div>

        {/* Features */}
        {featureItems.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {featureItems.map((item) => (
              <li key={item} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem', color: '#a0aec0' }}>
                <span style={{ color: accent, marginTop: 2, flexShrink: 0 }}>&#x2713;</span>
                {item}
              </li>
            ))}
          </ul>
        )}

        {/* Trunk upgrade note */}
        {isTrunkMaxed && (
          <p style={{ fontSize: '0.73rem', color: GLASS.textMuted, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12, marginTop: 'auto' }}>
            Trunk CPS is fixed at 5. Purchase additional call paths for more concurrent capacity.
          </p>
        )}
      </div>
    </GlassCard>
  );
}
