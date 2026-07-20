/**
 * Loading / error / empty presentational states for the Carriers admin page.
 * All frosted glass, driven by props.
 */

import { type ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { stateIcon, shimmerLine } from '../styles';

/** A grid of shimmering skeleton cards standing in for the carrier grid. */
export function CarriersSkeleton() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16 }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <GlassPanel key={i} padding="22px 24px">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
            <div style={shimmerLine(150, 20)} />
            <div style={shimmerLine(70, 20)} />
          </div>
          <div style={{ ...shimmerLine('100%', 110), marginBottom: 16 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={shimmerLine(110, 28)} />
            <div style={{ ...shimmerLine(70, 28), marginLeft: 'auto' }} />
            <div style={shimmerLine(70, 28)} />
          </div>
        </GlassPanel>
      ))}
    </div>
  );
}

export function StateCard({ icon, title, body, accent = GLASS.accent }: { icon: ReactNode; title: string; body: string; accent?: string }) {
  return (
    <GlassPanel padding="48px 40px" accent={accent}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
        <div style={stateIcon(accent)}>{icon}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 380, lineHeight: 1.5 }}>{body}</div>
      </div>
    </GlassPanel>
  );
}
