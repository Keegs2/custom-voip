/**
 * StatTiles — the three frosted summary tiles (total / active / disabled)
 * shown above the number grid.
 */

import { GlassCard } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { statGrid, statInset, statValue, statLabel } from '../styles';

function Tile({ label, value, accent, index }: { label: string; value: number; accent: string; index: number }) {
  return (
    <GlassCard index={index} accent={accent}>
      <div style={statInset}>
        <span style={{ ...statValue, color: accent }}>{value}</span>
        <span style={statLabel}>{label}</span>
      </div>
    </GlassCard>
  );
}

export function StatTiles({ total, active, disabled }: { total: number; active: number; disabled: number }) {
  return (
    <div style={statGrid}>
      <Tile index={0} label="Total Numbers" value={total} accent={GLASS.text} />
      <Tile index={1} label="Active" value={active} accent={GLASS.accent} />
      <Tile index={2} label="Disabled" value={disabled} accent={GLASS.textFaint} />
    </div>
  );
}
