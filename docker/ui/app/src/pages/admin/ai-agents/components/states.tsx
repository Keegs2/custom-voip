/**
 * Loading / error / empty presentational states for the AI Voice Agents page.
 * All frosted glass, driven by props.
 */

import { type ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { stateIcon, shimmerLine } from '../styles';

/** Shimmering skeleton standing in for the agents table while it loads. */
export function AgentsSkeleton() {
  return (
    <GlassPanel padding={18}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={shimmerLine(180, 20)} />
            <div style={shimmerLine(70, 20)} />
            <div style={{ ...shimmerLine(220, 20), marginLeft: 'auto' }} />
            <div style={shimmerLine(90, 20)} />
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
