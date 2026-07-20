/**
 * Glass status pills for a carrier's enabled state, role (primary / failover),
 * and the product types it serves. These wrap the canonical <GlassChip> so the
 * status semantics read as frosted-glass badges consistent with the rest of the
 * page. Each chip keeps a semantic colour (status), not the page accent.
 */

import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';

/** Product-type accent colours mirror the per-product hues used app-wide. */
const PRODUCT_COLOR: Record<string, string> = {
  rcf: GLASS.green,
  api: '#c084fc',
  trunk: '#fbbf24',
};

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled
    ? <GlassChip label="Enabled" color={GLASS.success} dot />
    : <GlassChip label="Disabled" color={GLASS.textMuted} />;
}

export function PrimaryBadge() {
  return <GlassChip label="Primary" color={GLASS.accent} dot />;
}

export function FailoverBadge() {
  return <GlassChip label="Failover" color={GLASS.cyan} />;
}

export function ProductTypeBadge({ type }: { type: string }) {
  return <GlassChip label={type} color={PRODUCT_COLOR[type] ?? GLASS.textMuted} />;
}
