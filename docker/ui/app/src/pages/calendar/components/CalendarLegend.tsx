/**
 * CalendarLegend — the per-provider colour key shown above the calendar grid.
 * Stateless; one swatch + label per connected provider.
 */

import type { CalendarProvider } from '../../../types/calendar';
import { PROVIDER_META } from '../providerMeta';
import { legendDot, legendItem, legendLabel, legendRow } from '../styles';

interface CalendarLegendProps {
  connectedProviders: CalendarProvider[];
}

export function CalendarLegend({ connectedProviders }: CalendarLegendProps) {
  if (connectedProviders.length === 0) return null;
  return (
    <div style={legendRow}>
      {connectedProviders.map((p) => (
        <span key={p} style={legendItem}>
          <span style={legendDot(PROVIDER_META[p].color)} />
          <span style={legendLabel}>{PROVIDER_META[p].label}</span>
        </span>
      ))}
    </div>
  );
}
