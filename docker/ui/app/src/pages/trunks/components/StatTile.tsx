/**
 * StatTile — a single frosted-glass metric tile (label + large value), used both
 * for the page-level trunk totals and the per-trunk live-activity row.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { statTileLabel, statTileValue } from '../styles';

interface StatTileProps {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  accent?: string;
}

export function StatTile({ label, value, icon, accent = GLASS.accent }: StatTileProps) {
  return (
    <GlassPanel padding="14px 16px" radius={16} accent={accent}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <span style={statTileLabel}>{label}</span>
        {icon && <span style={{ fontSize: '1rem', opacity: 0.85 }}>{icon}</span>}
      </div>
      <div style={statTileValue}>{value}</div>
    </GlassPanel>
  );
}
