/**
 * TollFreeStatsBar — inventory summary tiles from `/toll-free/stats`: total plus
 * the key lifecycle counts, and a compact CR-status breakdown. Purely presentational.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { TfnStats } from '../../../../types/tollFree';
import { statValue, statLabel } from '../styles';
import { statusColor, crStatusColor } from '../types';

function Tile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 120, padding: '14px 16px' }}>
      <div style={{ ...statValue, color: accent ?? GLASS.text }}>{value.toLocaleString()}</div>
      <div style={statLabel}>{label}</div>
    </div>
  );
}

export function TollFreeStatsBar({ stats }: { stats: TfnStats }) {
  const s = stats.by_status;
  const crEntries = Object.entries(stats.by_cr_status).filter(([k]) => k && k !== 'null');

  return (
    <GlassPanel padding={0}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <Tile label="Total TFNs" value={stats.total} accent={GLASS.accent} />
        <Tile label="Active" value={s['active'] ?? 0} accent={statusColor('active')} />
        <Tile label="Assigned" value={s['assigned'] ?? 0} accent={statusColor('assigned')} />
        <Tile label="Spare" value={s['spare'] ?? 0} accent={statusColor('spare')} />
        <Tile label="Reserved" value={s['reserved'] ?? 0} accent={statusColor('reserved')} />
      </div>
      {crEntries.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 16px 14px' }}>
          <span style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: GLASS.textFaint, alignSelf: 'center' }}>
            CR status
          </span>
          {crEntries.map(([k, v]) => (
            <span
              key={k}
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                color: crStatusColor(k),
                background: 'rgba(255,255,255,0.03)',
                border: `1px solid ${crStatusColor(k)}44`,
                borderRadius: 8,
                padding: '3px 9px',
              }}
            >
              {k}: {v.toLocaleString()}
            </span>
          ))}
        </div>
      )}
    </GlassPanel>
  );
}
