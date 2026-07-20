/**
 * StatTile — one inventory metric (total / available / assigned / reserved) as a
 * frosted glass card with an accent icon chip. Purely presentational.
 */

import type { ReactNode } from 'react';
import { GlassCard } from '../../../../components/glass/GlassCard';
import { statIconBox, statValue, statLabel } from '../styles';

interface StatTileProps {
  label: string;
  value: number | string;
  accent: string;
  icon: ReactNode;
  index?: number;
}

export function StatTile({ label, value, accent, icon, index = 0 }: StatTileProps) {
  return (
    <GlassCard accent={accent} index={index} style={{ flex: 1, minWidth: 200 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px' }}>
        <div style={statIconBox(accent)}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div style={statValue}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
          <div style={statLabel}>{label}</div>
        </div>
      </div>
    </GlassCard>
  );
}
