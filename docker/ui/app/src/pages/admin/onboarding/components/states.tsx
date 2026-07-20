/**
 * Loading / empty / error presentational states for the Onboarding admin page.
 * All frosted glass, all driven by props.
 */

import { type ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { shimmerLine, stateIcon } from '../styles';

/** A skeleton row mimicking a collapsed onboarding card. */
export function SkeletonCard() {
  return (
    <GlassPanel padding="16px 22px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div style={shimmerLine(11, 11)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...shimmerLine(160, 14), marginBottom: 8 }} />
          <div style={shimmerLine(220, 11)} />
        </div>
        <div style={shimmerLine(40, 26)} />
        <div style={shimmerLine(90, 12)} />
        <div style={shimmerLine(96, 22)} />
        <div style={shimmerLine(70, 12)} />
      </div>
    </GlassPanel>
  );
}

export function StateCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <GlassPanel padding="48px 40px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
        <div style={stateIcon()}>{icon}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 360, lineHeight: 1.5 }}>{body}</div>
      </div>
    </GlassPanel>
  );
}
