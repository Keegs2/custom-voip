/**
 * Loading / empty / error presentational states + the "load more" control for
 * the RCF glass page. All frosted-glass, all driven by props.
 */

import { useState, type ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { PAGE_SIZE } from '../types';
import { shimmerLine, stateIcon, loadMoreBtn } from '../styles';

function ShimmerLine({ w, h = 14, mb = 0 }: { w: string | number; h?: number; mb?: number }) {
  return <div style={shimmerLine(w, h, mb)} />;
}

export function SkeletonCard() {
  return (
    <GlassPanel padding="20px 22px">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
        <ShimmerLine w={64} h={18} />
        <ShimmerLine w={80} h={18} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}><ShimmerLine w={170} h={26} /></div>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}><ShimmerLine w={150} h={24} /></div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <ShimmerLine w={80} h={20} />
        <ShimmerLine w={90} h={20} />
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

export function LoadMore({ remaining, onClick }: { remaining: number; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={loadMoreBtn(hovered)}
      >
        Show {Math.min(remaining, PAGE_SIZE)} more · {remaining} hidden
      </button>
    </div>
  );
}
