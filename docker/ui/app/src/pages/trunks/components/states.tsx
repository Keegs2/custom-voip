/**
 * Loading / error / no-match presentational states for the Trunks glass page.
 * All frosted-glass, driven by props.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { stateIcon, shimmerLine } from '../styles';
import { IconError } from './icons';

function ShimmerLine({ w, h = 14, mb = 0 }: { w: string | number; h?: number; mb?: number }) {
  return <div style={shimmerLine(w, h, mb)} />;
}

/** A skeleton standing in for a single collapsed trunk card while loading. */
export function SkeletonTrunkCard() {
  return (
    <GlassPanel padding="22px 24px">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <ShimmerLine w={180} h={20} mb={10} />
          <ShimmerLine w={260} h={12} />
        </div>
        <ShimmerLine w={70} h={22} />
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <ShimmerLine w="25%" h={14} />
        <ShimmerLine w="25%" h={14} />
        <ShimmerLine w="25%" h={14} />
      </div>
    </GlassPanel>
  );
}

export function StateCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <GlassPanel padding="44px 40px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
        <div style={stateIcon()}>{icon}</div>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 380, lineHeight: 1.5 }}>{body}</div>
      </div>
    </GlassPanel>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <GlassPanel padding="20px 24px" accent={GLASS.danger}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: GLASS.danger }}>
        <IconError />
        <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>{message}</span>
      </div>
    </GlassPanel>
  );
}
