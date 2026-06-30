/**
 * QualityOverview — the stat-tile row (Total Calls, ASR, MOS, Packet Loss,
 * Jitter, R-Factor) inside a frosted glass panel. Driven by computed stats.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { OverviewStats } from '../types';
import { asrColor, jitterColor, mosColor, mosLabel, packetLossColor, rFactorColor } from '../quality';
import {
  sectionLabel,
  statTile,
  statTileEdge,
  statTileLabel,
  statTileValue,
  statTileSub,
  inlineState,
  spinnerRing,
} from '../styles';

function StatTile({ label, value, accent, sub }: { label: string; value: ReactNode; accent: string; sub?: string }) {
  return (
    <div style={statTile(accent)}>
      <div style={statTileEdge(accent)} />
      <div style={statTileLabel}>{label}</div>
      <div style={statTileValue(accent)}>{value}</div>
      {sub && <div style={statTileSub}>{sub}</div>}
    </div>
  );
}

export function QualityOverview({ stats, isLoading }: { stats: OverviewStats; isLoading: boolean }) {
  return (
    <GlassPanel padding="24px 26px">
      <div style={{ ...sectionLabel(), marginBottom: 16 }}>Quality Overview</div>
      {isLoading ? (
        <div style={inlineState}>
          <span style={spinnerRing()} /> Computing metrics…
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          <StatTile label="Total Calls" value={stats.totalCalls.toLocaleString()} accent={GLASS.accent} />
          <StatTile
            label="ASR"
            value={`${stats.asr}%`}
            accent={asrColor(stats.asr)}
            sub={`${stats.answeredCalls.toLocaleString()} answered`}
          />
          <StatTile
            label="Avg MOS"
            value={stats.avgMos != null ? stats.avgMos.toFixed(2) : '—'}
            accent={mosColor(stats.avgMos)}
            sub={stats.avgMos != null ? mosLabel(stats.avgMos) : undefined}
          />
          <StatTile
            label="Avg Pkt Loss"
            value={stats.avgPacketLossPct != null ? `${stats.avgPacketLossPct.toFixed(2)}%` : '—'}
            accent={packetLossColor(stats.avgPacketLossPct)}
          />
          <StatTile
            label="Avg Jitter"
            value={stats.avgJitterMs != null ? `${stats.avgJitterMs.toFixed(1)}ms` : '—'}
            accent={jitterColor(stats.avgJitterMs)}
          />
          <StatTile
            label="Avg R-Factor"
            value={stats.avgRFactor != null ? stats.avgRFactor.toFixed(1) : '—'}
            accent={rFactorColor(stats.avgRFactor)}
          />
        </div>
      )}
    </GlassPanel>
  );
}
