/**
 * StatusChip — the glass status pill for an onboarding request. The colour maps
 * onto the glass palette via `statusColor` (blue default, amber pending, green
 * active, red rejected, cyan in-flight).
 */

import { GlassChip } from '../../../../components/glass/GlassCard';
import type { OnboardingStatus } from '../../../../types/onboarding';
import { statusColor, statusLabel } from '../helpers';

export function StatusChip({ status }: { status: OnboardingStatus }) {
  return <GlassChip label={statusLabel(status)} color={statusColor(status)} dot />;
}
