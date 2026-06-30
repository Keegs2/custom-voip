/**
 * Loading / error presentational states for the Customers admin page. All
 * frosted-glass, all driven by props.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { COL_COUNT } from '../types';
import { shimmerLine, stateIcon, th } from '../styles';

/** A shimmering skeleton table shown while the first page loads. */
export function CustomerTableSkeleton() {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
              {['ID', 'Name', 'Type', 'Balance', 'Status', 'Grade', 'Created'].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 8 }).map((_, r) => (
              <tr key={r}>
                {Array.from({ length: COL_COUNT }).map((__, c) => (
                  <td key={c} style={{ padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={shimmerLine(c === 1 ? '70%' : '50%', 14)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}

export function StateCard({ icon, title, body, accent = GLASS.accent }: { icon: ReactNode; title: string; body: string; accent?: string }) {
  return (
    <GlassPanel padding="48px 40px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
        <div style={stateIcon(accent)}>{icon}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 360, lineHeight: 1.5 }}>{body}</div>
      </div>
    </GlassPanel>
  );
}
