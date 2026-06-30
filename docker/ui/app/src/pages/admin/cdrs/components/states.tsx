/**
 * Glass loading / error / empty states for the CDRs admin feature. All surfaces
 * are frosted glass so they sit consistently on the app-wide backdrop.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { spinnerRing, shimmerBlock, stateIcon } from '../styles';

/** Inline spinner + label row (frosted), used while the first page loads. */
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

/** A stack of shimmering skeleton rows. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <GlassPanel padding={18}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={shimmerBlock(40)} />
        ))}
      </div>
    </GlassPanel>
  );
}

/** Centered glass card for error / empty states. */
export function StateCard({ icon, title, body, accent = GLASS.accent }: {
  icon: ReactNode;
  title: string;
  body: string;
  accent?: string;
}) {
  return (
    <GlassPanel accent={accent} padding="40px 28px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14 }}>
        <div style={stateIcon(accent)}>{icon}</div>
        <div>
          <p style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: GLASS.text }}>{title}</p>
          <p style={{ margin: '6px 0 0', fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 460, lineHeight: 1.5 }}>{body}</p>
        </div>
      </div>
    </GlassPanel>
  );
}
