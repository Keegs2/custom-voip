/**
 * Loading / error / empty presentational states for the Toll-Free admin page.
 */

import { type ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { stateIcon, shimmerLine } from '../styles';

export function TableSkeleton() {
  return (
    <GlassPanel padding={18}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={shimmerLine(150, 18)} />
            <div style={shimmerLine(110, 18)} />
            <div style={shimmerLine(80, 18)} />
            <div style={{ ...shimmerLine(90, 18), marginLeft: 'auto' }} />
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
