/**
 * Loading / error / empty presentational states for the Trunks admin page.
 * All frosted glass, driven by props.
 */

import { type ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { stateIcon, shimmerLine } from '../styles';

/** A shimmering skeleton standing in for the trunks table while it loads. */
export function TrunksSkeleton() {
  return (
    <GlassPanel padding="18px 20px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={shimmerLine(40, 16)} />
            <div style={shimmerLine('22%', 16)} />
            <div style={shimmerLine('18%', 16)} />
            <div style={shimmerLine(70, 16)} />
            <div style={{ ...shimmerLine(80, 16), marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

export function StateCard({ icon, title, body, accent = GLASS.accent }: { icon: ReactNode; title: string; body: string; accent?: string }) {
  return (
    <GlassPanel padding="48px 40px" accent={accent}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
        <div style={stateIcon(accent)}>{icon}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 360, lineHeight: 1.5 }}>{body}</div>
      </div>
    </GlassPanel>
  );
}
