/**
 * Loading / error / empty presentational states for the LCO admin feature.
 */

import { type ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { stateIcon, shimmerLine, spinnerRing } from '../styles';

export function LoadingRow({ label }: { label: string }) {
  return (
    <GlassPanel padding="18px 22px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: GLASS.textMuted, fontSize: '0.85rem' }}>
        <span style={spinnerRing()} />
        {label}
      </div>
    </GlassPanel>
  );
}

export function TableSkeleton() {
  return (
    <GlassPanel padding={18}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={shimmerLine(120, 18)} />
            <div style={shimmerLine(90, 18)} />
            <div style={shimmerLine(70, 18)} />
            <div style={{ ...shimmerLine(80, 18), marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

export function StateCard({
  icon,
  title,
  body,
  accent = GLASS.accent,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  accent?: string;
}) {
  return (
    <GlassPanel padding="48px 40px" accent={accent}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14 }}>
        <div style={stateIcon(accent)}>{icon}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 420, lineHeight: 1.5 }}>{body}</div>
      </div>
    </GlassPanel>
  );
}
