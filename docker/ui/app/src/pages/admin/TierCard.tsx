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

export function TierCard({ tier, tierType, fullWidth = false }: TierCardProps) {
  const maxCps = MAX_CPS[tierType] ?? 15;
  const fillPct = Math.min(100, Math.round((tier.cps_limit / maxCps) * 100));
  const isTrunkMaxed = tierType === 'trunk' && tier.cps_limit >= 5;
  const isApiStandard = tierType === 'api' && tier.name === 'api_standard';

  const { items: featureItems } = parseFeatures(tier.features);

  const perCallFee = parseFloat(String(tier.per_call_fee));
  const monthlyFeeLabel =
    tier.monthly_fee === 0 ? 'Free' : `$${Number(tier.monthly_fee).toFixed(2)}/mo`;

  // Accent colour by type
  const nameColorClass =
    tierType === 'trunk'
      ? 'text-amber-300'
      : tier.name.includes('premium')
        ? 'text-blue-300'
        : tier.name.includes('basic')
          ? 'text-slate-300'
          : 'text-violet-300';

  const barColorClass =
    tierType === 'trunk'
      ? 'bg-amber-400'
      : isApiStandard
        ? 'bg-blue-400'
        : 'bg-violet-400';

  return (
    <div
      className={cn(
        'bg-[#1e2130] border border-[#2a2f45] rounded-xl p-5',
        'flex flex-col gap-4',
        'transition-all duration-200 hover:border-[#363c57]',
        isApiStandard && 'border-blue-500/30 shadow-[0_0_16px_rgba(59,130,246,0.08)]',
        fullWidth && 'col-span-full',
      )}
    >
      {/* Name */}
      <div>
        <div className={cn('text-[1.05rem] font-bold', nameColorClass)}>
          {displayName(tier.name)}
        </div>
        {tier.description && (
          <p className="text-[0.78rem] text-[#718096] mt-1">{tier.description}</p>
        )}
      </div>

      {/* CPS + progress bar */}
      <div>
        <div className="flex items-baseline gap-1 mb-2">
          <span className="text-[1.8rem] font-extrabold text-[#e2e8f0] tabular-nums leading-none">
            {tier.cps_limit}
          </span>
          <span className="text-[0.78rem] font-semibold text-[#718096]">CPS</span>
        </div>
        <div className="h-1.5 rounded-full bg-[#2a2f45] overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-500', barColorClass)}
            style={{ width: `${fillPct}%` }}
          />
        </div>
      </div>

      {/* Pricing */}
      <div className="text-[0.9rem] font-semibold text-[#e2e8f0]">
        {monthlyFeeLabel}
        {!isNaN(perCallFee) && perCallFee > 0 && (
          <span className="text-[#718096] font-normal ml-1">
            &middot; ${perCallFee.toFixed(4)}/call
          </span>
        )}
      </div>

      {/* Features */}
      {featureItems.length > 0 && (
        <ul className="space-y-1">
          {featureItems.map((item) => (
            <li
              key={item}
              className="flex items-start gap-1.5 text-[0.8rem] text-[#a0aec0]"
            >
              <span className="text-[#3b82f6] mt-0.5 flex-shrink-0">&#x2713;</span>
              {item}
            </li>
          ))}
        </ul>
      )}

      {/* Trunk upgrade note */}
      {isTrunkMaxed && (
        <p className="text-[0.73rem] text-[#718096] border-t border-[#2a2f45] pt-3 mt-auto">
          Trunk CPS is fixed at 5. Purchase additional call paths for more concurrent capacity.
        </p>
      )}
    </div>
  );
}
