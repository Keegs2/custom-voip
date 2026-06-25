/**
 * StatusChip — the enabled/disabled pill for an RCF line. Uses the app-blue
 * accent for "Active" (keeps the page reading blue) and danger red for disabled.
 */

import { GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';

export function StatusChip({ enabled }: { enabled: boolean }) {
  const color = enabled ? GLASS.accent : GLASS.danger;
  return <GlassChip label={enabled ? 'Active' : 'Disabled'} color={color} dot />;
}
