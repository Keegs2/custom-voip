/**
 * Shared loading / error / offline / empty presentational states for the
 * live-ops pages. All frosted glass, all prop-driven. Mirrors the reference
 * `pages/rcf-glass/components/states.tsx` but adds an `accent` so a state can
 * read warning-amber (ESL offline) or danger-red (error) instead of blue.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { shimmerLine, stateIcon, spinner } from './styles';

/** Generic frosted state card (icon + title + body), tinted by `accent`. */
export function GlassStateCard({
  icon,
  title,
  body,
  accent = GLASS.accent,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  accent?: string;
}) {
  return (
    <GlassPanel padding="48px 40px" accent={accent}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
        <div style={stateIcon(accent)}>{icon}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        {body && <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 380, lineHeight: 1.5 }}>{body}</div>}
      </div>
    </GlassPanel>
  );
}

/** A frosted skeleton table used while a monitoring query is loading. */
export function GlassSkeletonTable({ columns = 5, rows = 6 }: { columns?: number; rows?: number }) {
  return (
    <GlassPanel padding="14px 18px" blur={20}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, opacity: 0.7 }}>
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} style={{ flex: 1 }}>
            <div style={shimmerLine('60%', 12)} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            {Array.from({ length: columns }).map((_, c) => (
              <div key={c} style={{ flex: 1 }}>
                <div style={shimmerLine(c === 0 ? '85%' : '55%', 16)} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

/** Inline spinner row — used inside expanded panels (drill-in member lists). */
export function GlassSpinnerRow({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 4px', color: GLASS.textMuted, fontSize: '0.85rem' }}>
      <span style={spinner()} />
      {label}
    </div>
  );
}
