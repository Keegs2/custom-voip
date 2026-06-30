/**
 * QualityTrends — the three daily trend charts (MOS, packet loss, jitter) inside
 * a frosted glass panel, with loading + empty states.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { TrendPoint } from '../types';
import { QualityTrendChart } from './QualityTrendChart';
import { sectionLabel, inlineState, emptyState, spinnerRing } from '../styles';

interface QualityTrendsProps {
  mosPts: TrendPoint[];
  plPts: TrendPoint[];
  jPts: TrendPoint[];
  isLoading: boolean;
  hasData: boolean;
}

export function QualityTrends({ mosPts, plPts, jPts, isLoading, hasData }: QualityTrendsProps) {
  return (
    <GlassPanel padding="24px 26px">
      <div style={{ ...sectionLabel(), marginBottom: 16 }}>Quality Trends</div>
      {isLoading ? (
        <div style={inlineState}>
          <span style={spinnerRing()} /> Building charts…
        </div>
      ) : !hasData ? (
        <div style={emptyState}>No CDR data for the selected filters. Adjust the criteria and search again.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
          <QualityTrendChart points={mosPts} accent={GLASS.success} label="MOS Score — Daily Avg" formatY={(v) => v.toFixed(2)} yMin={1} yMax={5} />
          <QualityTrendChart points={plPts} accent={GLASS.danger} label="Packet Loss % — Daily Avg" formatY={(v) => `${v.toFixed(2)}%`} yMin={0} />
          <QualityTrendChart points={jPts} accent={GLASS.warning} label="Jitter (avg ms) — Daily" formatY={(v) => `${v.toFixed(1)}ms`} yMin={0} />
        </div>
      )}
    </GlassPanel>
  );
}
