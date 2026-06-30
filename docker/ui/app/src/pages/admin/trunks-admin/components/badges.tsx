/**
 * Glass status pills for trunk auth type and enabled state. These wrap the
 * canonical <GlassChip> so the auth/status semantics read as frosted-glass
 * badges consistent with the rest of the page.
 */

import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { TrunkAuthType } from '../../../../types/trunk';

export function AuthTypeBadge({ type }: { type: TrunkAuthType }) {
  if (type === 'ip') return <GlassChip label="IP" color={GLASS.cyan} />;
  if (type === 'credentials') return <GlassChip label="Creds" color={GLASS.accent} />;
  return <GlassChip label="Both" color="#c084fc" />;
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled
    ? <GlassChip label="Enabled" color={GLASS.success} dot />
    : <GlassChip label="Disabled" color={GLASS.textMuted} />;
}
